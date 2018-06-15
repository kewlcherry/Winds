import '../loadenv';

import stream from 'getstream';
import moment from 'moment';
import normalize from 'normalize-url';

import RSS from '../models/rss';
import Article from '../models/article';

import '../utils/db';
import config from '../config';
import logger from '../utils/logger';

import sendRssFeedToCollections from '../utils/events/sendRssFeedToCollections';
import { ParseFeed } from '../parsers/feed';

import { ProcessRssQueue, OgQueueAdd } from '../asyncTasks';
import { getStatsDClient, timeIt } from '../utils/statsd';

const streamClient = stream.connect(config.stream.apiKey, config.stream.apiSecret);
const duplicateKeyError = 11000;

// connect the handler to the queue
logger.info('Starting the RSS worker');

//TODO: move this to a separate main.js
ProcessRssQueue(100, rssProcessor);

const statsd = getStatsDClient();

export async function rssProcessor(job) {
	logger.info(`Processing ${job.data.url}`);
	// just intercept error handling before it goes to Bull
	try {
		await handleRSS(job);
	} catch (err) {
		let tags = { queue: 'rss' };
		let extra = {
			JobRSS: job.data.rss,
			JobURL: job.data.url,
		};
		logger.error('RSS job encountered an error', { err, tags, extra });
	}
	logger.info(`Completed scraping for ${job.data.url}`);
}

// Handle Podcast scrapes the podcast and updates the episodes
export async function handleRSS(job) {
	let rssID = job.data.rss;

	await timeIt('winds.handle_rss.ack', () => {
		return markDone(rssID);
	});

	let rss = await timeIt('winds.handle_rss.get_rss', () => {
		return RSS.findOne({ _id: rssID });
	});

	if (!rss) {
		logger.warn(`RSS with ID ${rssID} does not exist`);
		return;
	}

	logger.info(`Marked ${rssID} as done`);

	// parse the articles
	let rssContent = await timeIt('winds.handle_rss.parsing', async () => {
		try {
			const res = await ParseFeed(job.data.url);
			await RSS.resetScrapeFailures(rssID);
			return res;
		} catch (err) {
			await RSS.incrScrapeFailures(rssID);
			throw err;
		}
	});

	if (!rssContent) {
		return;
	}

	// update the articles
	logger.info(`Updating ${rssContent.articles.length} articles for feed ${rssID}`);

	if (rssContent.articles.length === 0) {
		return;
	}

	statsd.increment('winds.handle_rss.articles.parsed', rssContent.articles.length);
	statsd.timing('winds.handle_rss.articles.parsed', rssContent.articles.length);

	let allArticles = await timeIt('winds.handle_rss.upsertManyArticles', () => {
		const articles = rssContent.articles.map(a => {
			try {
				a.url = normalize(a.url);
				a.contentHash = Article.computeContentHash(a);
			} catch (err) {
				logger.warn({err});
				return null;
			}
			return a;
		}).filter(a => a);
		return upsertManyArticles(rssID, articles);
	});

	// update the count
	await RSS.update(
		{ _id: rssID },
		{
			postCount: await Article.count({rss: rssID}),
		}
	);

	// updatedArticles will contain `null` for all articles that didn't get updated, that we already have in the system.
	let updatedArticles = allArticles.filter(updatedArticle => {
		return updatedArticle;
	});

	statsd.increment('winds.handle_rss.articles.upserted', updatedArticles.length);

	await timeIt('winds.handle_rss.OgQueueAdd', () => {
		return Promise.all(
			updatedArticles.map(article => {
				OgQueueAdd(
					{
						type: 'article',
						url: article.url,
					},
					{
						removeOnComplete: true,
						removeOnFail: true,
					},
				);
			}),
		);
	});

	let t0 = new Date();
	let rssFeed = streamClient.feed('rss', rssID);
	logger.info(`Syncing ${updatedArticles.length} articles to Stream`);
	if (updatedArticles.length > 0) {
		let chunkSize = 100;
		for (let i = 0, j = updatedArticles.length; i < j; i += chunkSize) {
			let chunk = updatedArticles.slice(i, i + chunkSize);
			let streamArticles = chunk.map(article => {
				return {
					actor: article.rss,
					foreign_id: `articles:${article._id}`,
					object: article._id,
					time: article.publicationDate,
					verb: 'rss_article',
				};
			});
			await rssFeed.addActivities(streamArticles);
		}
		await sendRssFeedToCollections(rss);
	}
	statsd.timing('winds.handle_rss.send_to_stream', new Date() - t0);
}

export async function upsertManyArticles(rssID, articles) {
	const searchData = articles.map(article => {
		return {url: article.url, contentHash: article.contentHash};
	});

	const existingArticles = await Article.find({$and: [{rss: rssID}, {$or: searchData }]}, { url: 1, contentHash: 1 }).read('sp');

	const existingArticleUrls = existingArticles.map(a => a.url);
	const existingArticleHashes = existingArticles.map(a => a.contentHash);

	statsd.increment('winds.handle_rss.articles.already_in_mongo', existingArticleUrls.length);

	const articlesToUpsert = articles.filter(article => {
		return !existingArticleUrls.includes(article.url) && !existingArticleHashes.includes(article.contentHash);
	});

	logger.info(`Feed ${rssID}: got ${articles.length} articles of which ${articlesToUpsert.length} need a sync`);

	return Promise.all(articlesToUpsert.map(article => upsertArticle(rssID, article)));
}

// updateArticle updates the article in mongodb if it changed and create a new one if it did not exist
export async function upsertArticle(rssID, post) {
	const search = {
		commentUrl: post.commentUrl,
		content: post.content,
		description: post.description,
		title: post.title,
	};
	const update = Object.assign({}, search, {
		url: post.url,
		rss: rssID,
		contentHash: post.contentHash,
		enclosures: post.enclosures || {},
		images: post.images || {},
		publicationDate: post.publicationDate
	});
	// Query matches fields affecting content hash
	const postContentDiffers = Object.keys(search).map(k => {
		return { [k]: { $ne: search[k] } };
	});

	try {
		// Find article in feed w/ rssID matching post url but w/ different content
		const rawArticle = await Article.findOneAndUpdate(
			{
				$and: [
					{ rss: rssID, url: post.url },
					{ $or: postContentDiffers }
				],
			},
			update,
			{
				new: true,
				upsert: true,
				rawResult: true,
			},
		);
		if (!rawArticle.lastErrorObject.updatedExisting) {
			return rawArticle.value;
		}
	} catch (err) {
		if (err.code === duplicateKeyError) {
			statsd.increment('winds.handle_rss.articles.ignored');
			return null;
		}
		throw err;
	}
}

// markDone sets lastScraped to now and isParsing to false
async function markDone(rssID) {
	const now = moment().toISOString();
	return await RSS.update(
		{ _id: rssID },
		{ lastScraped: now, isParsing: false },
	);
}
