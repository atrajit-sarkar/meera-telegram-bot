/**
 * Content Fetcher — fetches trending memes, videos, and YouTube Shorts
 * Sources: Reddit public JSON API + YouTube Data API v3
 */

export interface ContentPost {
  title: string;
  url: string;          // Direct image/video URL or YouTube link
  permalink: string;    // Source link
  source: string;       // "reddit" | "youtube"
  subreddit?: string;
  isVideo: boolean;
  isImage: boolean;
  isYouTubeLink: boolean;  // True = send as URL, not as upload
  score: number;
  nsfw: boolean;
}

// Subreddits to fetch from — mix of Indian and international humor
const MEME_SUBREDDITS = [
  "memes",
  "IndianMemes",
  "BollywoodMemes",
  "dankmemes",
  "me_irl",
  "wholesomememes",
  "funnyvideos",
  "Unexpected",
  "MadeMeSmile",
];

const REEL_SUBREDDITS = [
  "funnyvideos",
  "Unexpected",
  "BetterEveryLoop",
  "ContagiousLaughter",
];

// Cache fetched posts per source to avoid re-fetching constantly
const postCache = new Map<string, { posts: ContentPost[]; fetchedAt: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Track sent post URLs per user to avoid repeats
const sentPosts = new Map<number, Set<string>>();

/** Track a URL as sent to a user */
function markSent(userId: number, url: string) {
  if (!sentPosts.has(userId)) sentPosts.set(userId, new Set());
  const userSent = sentPosts.get(userId)!;
  userSent.add(url);
  // Limit tracking set size
  if (userSent.size > 200) {
    const arr = [...userSent];
    sentPosts.set(userId, new Set(arr.slice(-100)));
  }
}

// YouTube API key (optional — if not set, YouTube Shorts won't be fetched)
const YT_API_KEY = process.env.YOUTUBE_API_KEY ?? "";

/** Fetch top/hot posts from a subreddit */
async function fetchSubreddit(
  subreddit: string,
  sort: "hot" | "top" = "hot",
  limit = 30
): Promise<ContentPost[]> {
  // Check cache
  const cached = postCache.get(subreddit);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.posts;
  }

  try {
    const url = `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${limit}&t=day`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "MeeraBot/1.0 (Telegram Bot)",
      },
    });

    if (!res.ok) {
      console.error(`[Reddit] Failed to fetch r/${subreddit}: ${res.status}`);
      return cached?.posts ?? [];
    }

    const data = await res.json();
    const posts: ContentPost[] = [];

    for (const child of data?.data?.children ?? []) {
      const post = child?.data;
      if (!post) continue;

      // Skip NSFW, self posts, removed posts
      if (post.over_18) continue;
      if (post.is_self) continue;
      if (post.removed_by_category) continue;

      const postUrl: string = post.url ?? "";
      const isImage = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(postUrl)
        || post.post_hint === "image";
      const isVideo = post.is_video
        || post.post_hint === "hosted:video"
        || post.post_hint === "rich:video"
        || /\.(mp4|webm)(\?.*)?$/i.test(postUrl);

      // Only keep posts with direct media
      if (!isImage && !isVideo) continue;

      // For Reddit videos, get the fallback URL
      let mediaUrl = postUrl;
      if (post.is_video && post.media?.reddit_video?.fallback_url) {
        mediaUrl = post.media.reddit_video.fallback_url;
      }

      posts.push({
        title: post.title ?? "",
        url: mediaUrl,
        permalink: `https://reddit.com${post.permalink}`,
        source: "reddit",
        subreddit: post.subreddit ?? subreddit,
        isVideo,
        isImage,
        isYouTubeLink: false,
        score: post.score ?? 0,
        nsfw: false,
      });
    }

    // Cache the results
    postCache.set(subreddit, { posts, fetchedAt: Date.now() });
    console.log(`[Reddit] Fetched ${posts.length} posts from r/${subreddit}`);
    return posts;
  } catch (err) {
    console.error(`[Reddit] Error fetching r/${subreddit}:`, err);
    return cached?.posts ?? [];
  }
}

/** Get a random meme (image) that hasn't been sent to this user before */
export async function getRandomMeme(userId: number): Promise<ContentPost | null> {
  // Pick 2-3 random subreddits to fetch from
  const shuffled = [...MEME_SUBREDDITS].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 3);

  const allPosts: ContentPost[] = [];
  for (const sub of selected) {
    const posts = await fetchSubreddit(sub);
    allPosts.push(...posts.filter((p) => p.isImage));
  }

  if (!allPosts.length) return null;

  // Filter out already sent posts
  const sent = sentPosts.get(userId) ?? new Set();
  const unseen = allPosts.filter((p) => !sent.has(p.url));

  // If all seen, reset and pick from all
  const pool = unseen.length > 0 ? unseen : allPosts;

  // Pick a random post, weighted slightly toward higher scores
  pool.sort((a, b) => b.score - a.score);
  // Top 60% are more likely
  const idx = Math.random() < 0.7
    ? Math.floor(Math.random() * Math.min(pool.length, Math.ceil(pool.length * 0.6)))
    : Math.floor(Math.random() * pool.length);

  const pick = pool[idx];

  // Track it
  markSent(userId, pick.url);

  return pick;
}

/** Get a random funny video post */
export async function getRandomFunnyVideo(userId: number): Promise<ContentPost | null> {
  const shuffled = [...REEL_SUBREDDITS].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 2);

  const allPosts: ContentPost[] = [];
  for (const sub of selected) {
    const posts = await fetchSubreddit(sub);
    allPosts.push(...posts.filter((p) => p.isVideo));
  }

  if (!allPosts.length) return null;

  const sent = sentPosts.get(userId) ?? new Set();
  const unseen = allPosts.filter((p) => !sent.has(p.url));
  const pool = unseen.length > 0 ? unseen : allPosts;

  const pick = pool[Math.floor(Math.random() * pool.length)];

  markSent(userId, pick.url);

  return pick;
}

/** Pick either a meme or video randomly (70% meme, 30% video) */
export async function getRandomContent(userId: number): Promise<ContentPost | null> {
  if (Math.random() < 0.70) {
    return getRandomMeme(userId);
  }
  return getRandomFunnyVideo(userId) ?? getRandomMeme(userId);
}

// ── YOUTUBE SHORTS ──────────────────────────────────────────────────

// Search queries for trending shorts — mix of Indian and international humor
const YT_SEARCH_QUERIES = [
  "funny shorts",
  "indian funny video short",
  "trending memes shorts",
  "relatable shorts",
  "comedy shorts",
  "dank memes shorts",
  "funny fails shorts",
  "bollywood meme shorts",
  "gen z humor shorts",
];

/** Fetch trending YouTube Shorts via YouTube Data API v3 */
async function fetchYouTubeShorts(query: string, maxResults = 15): Promise<ContentPost[]> {
  if (!YT_API_KEY) return [];

  const cacheKey = `yt:${query}`;
  const cached = postCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached.posts;
  }

  try {
    const params = new URLSearchParams({
      part: "snippet",
      q: query,
      type: "video",
      videoDuration: "short",  // Under 4 minutes (Shorts)
      order: "relevance",
      maxResults: String(maxResults),
      key: YT_API_KEY,
      safeSearch: "strict",
    });

    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (!res.ok) {
      console.error(`[YouTube] Failed to search "${query}": ${res.status}`);
      return cached?.posts ?? [];
    }

    const data = await res.json();
    const posts: ContentPost[] = [];

    for (const item of data?.items ?? []) {
      const videoId = item?.id?.videoId;
      const title = item?.snippet?.title ?? "";
      if (!videoId) continue;

      posts.push({
        title,
        url: `https://www.youtube.com/shorts/${videoId}`,
        permalink: `https://www.youtube.com/shorts/${videoId}`,
        source: "youtube",
        isVideo: true,
        isImage: false,
        isYouTubeLink: true,
        score: 0,
        nsfw: false,
      });
    }

    postCache.set(cacheKey, { posts, fetchedAt: Date.now() });
    console.log(`[YouTube] Fetched ${posts.length} shorts for "${query}"`);
    return posts;
  } catch (err) {
    console.error(`[YouTube] Error searching "${query}":`, err);
    return cached?.posts ?? [];
  }
}

/** Get a random YouTube Short */
export async function getRandomYouTubeShort(userId: number): Promise<ContentPost | null> {
  // Pick 1-2 random search queries
  const shuffled = [...YT_SEARCH_QUERIES].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 2);

  const allPosts: ContentPost[] = [];
  for (const q of selected) {
    const posts = await fetchYouTubeShorts(q);
    allPosts.push(...posts);
  }

  if (!allPosts.length) return null;

  const sent = sentPosts.get(userId) ?? new Set();
  const unseen = allPosts.filter((p) => !sent.has(p.url));
  const pool = unseen.length > 0 ? unseen : allPosts;

  const pick = pool[Math.floor(Math.random() * pool.length)];
  markSent(userId, pick.url);
  return pick;
}

/** Get any type of content — meme, Reddit video, or YouTube Short */
export async function getRandomContentAny(userId: number): Promise<ContentPost | null> {
  const roll = Math.random();
  if (roll < 0.50) {
    // 50% — image meme
    return getRandomMeme(userId);
  } else if (roll < 0.75) {
    // 25% — Reddit video
    return getRandomFunnyVideo(userId) ?? getRandomMeme(userId);
  } else {
    // 25% — YouTube Short (if API key available)
    if (YT_API_KEY) {
      return getRandomYouTubeShort(userId) ?? getRandomMeme(userId);
    }
    return getRandomMeme(userId);
  }
}

/**
 * Fetch content using an AI-generated search query and preferred content type.
 * The AI determines the best query based on the user's request (in any language).
 */
export async function getContentByAIQuery(
  userId: number,
  searchQuery: string,
  contentType: "meme" | "video" | "reel" | "any"
): Promise<ContentPost | null> {
  // For reels/video/any with YouTube API → use the AI's search query directly
  if ((contentType === "reel" || contentType === "video" || contentType === "any") && YT_API_KEY) {
    // Fetch using the AI-generated query
    const posts = await fetchYouTubeShorts(searchQuery);
    if (posts.length > 0) {
      const sent = sentPosts.get(userId) ?? new Set();
      const unseen = posts.filter((p) => !sent.has(p.url));
      const pool = unseen.length > 0 ? unseen : posts;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      markSent(userId, pick.url);
      console.log(`[Content] AI-query "${searchQuery}" → picked: ${pick.title.slice(0, 50)}`);
      return pick;
    }
    // Fallback: try with a generic query
    const fallback = await getRandomYouTubeShort(userId);
    if (fallback) return fallback;
  }

  // For memes → try Reddit image memes
  if (contentType === "meme") {
    return getRandomMeme(userId);
  }

  // Fallback to any content
  return getRandomContentAny(userId);
}

// ── MID-CHAT CONTENT SHARING ────────────────────────────────────────

// Keywords/patterns that might trigger Meera to share a meme mid-conversation
const MEME_TRIGGER_PATTERNS = [
  /\b(boring|bored|bore|nothing to do)\b/i,
  /\b(send (me )?(something|meme|video|reel|funny))\b/i,
  /\b(show me something|entertain me)\b/i,
  /\b(lol|lmao|haha|😂|🤣|💀){2,}/i,  // Multiple laughing = vibe is right
  /\b(meme|memes|funny video|reel|reels)\b/i,
  // Hindi/Bengali/Hinglish patterns
  /\b(bhej|bhejo|pathao|patao|de na|dena|dikha|dikhao|dikhana)\b/i,
  /\b(kuch funny|kuch mast|kuch acha|majja|moja|hansi)\b/i,
  /\b(bore ho raha|bore ho rahi|bore lagche|boring lagche)\b/i,
];

// Explicit content request patterns — English
const EXPLICIT_REQUEST_EN = [
  /send (me )?(a |some |another )?(meme|video|reel|something funny|content|funny)/i,
  /show me (a |some |another )?(meme|video|funny|something|reel)/i,
  /\b(entertain me)\b/i,
  /\b(one more|another one|send more|more memes|more reels|more videos)\b/i,
  /\b(again|send again|another)\b.*\b(meme|video|reel|funny)\b/i,
];

// Explicit content request patterns — Hindi/Bengali/Hinglish
const EXPLICIT_REQUEST_INDIC = [
  // Hindi: "bhej" / "bhejo" / "de" / "dena" + content words
  /(bhej|bhejo|de na|dena|dikha|dikhao)\s*(meme|video|reel|funny|kuch)/i,
  // Bengali: "pathao" / "patao" / "de" / "dao" + content words
  /(pathao|patao|dao|de|daw)\s*(meme|video|reel|funny|ekta|akta|kichhu)/i,
  // "aur ek" / "ek aur" / "ar ekta" / "arekta" — "another one" / "one more"
  /\b(aur ek|ek aur|ar ekta|arekta|aur bhej|aur pathao|aur de|aaro ekta|r ekta)\b/i,
  // "ekta pathao" / "ek bhej" — "send one"
  /\b(ekta|akta|ek)\s*(pathao|patao|bhej|bhejo|de|dao)\b/i,
  // Reversed: "pathao ekta" / "bhej ek"
  /\b(pathao|patao|bhej|bhejo)\s*(ekta|akta|ek|na|to)\b/i,
  // "hasi" / "hansi" / "funny" + "pathao" / "bhej" / "de"
  /(hasi|hansi|hasir|funny|moja|maza|majja)\s*.{0,10}\s*(pathao|bhej|de|dao|dikha)/i,
  /(pathao|bhej|de|dao|dikha)\s*.{0,10}\s*(hasi|hansi|hasir|funny|moja|maza|majja)/i,
  // Simple "ar ekta" / "aur ek" even without content words (if recently shared)
  /^(ar|aur|r)\s*(ekta|ek|1ta)\b/i,
];

/**
 * Decide if Meera should spontaneously share a meme/video during chat.
 * Returns true if she should share content alongside (or instead of) her text reply.
 *
 * This gets called during handleTextMessage. Triggers:
 * 1. User explicitly asks for content ("send me a meme", "show me something funny")
 * 2. Random chance during comfortable+ conversations (~5%)
 * 3. Conversation has "sharing vibe" (lots of laughing, bored energy)
 * 4. User asks for "another" after content was recently shared
 *
 * @param recentHistory — last few messages to detect "send another" after a share
 */
export function shouldShareContentMidChat(
  tier: string,
  userText: string,
  mood: string,
  recentHistory?: { role: string; content: string }[]
): { shouldShare: boolean; reason: "asked" | "vibe" | "random" } {
  // Only for comfortable+ tiers
  if (tier === "stranger" || tier === "acquaintance") {
    return { shouldShare: false, reason: "random" };
  }

  const text = userText.toLowerCase();

  // Explicit request (English) — always share
  if (EXPLICIT_REQUEST_EN.some((p) => p.test(text))) {
    return { shouldShare: true, reason: "asked" };
  }

  // Explicit request (Hindi/Bengali/Hinglish) — always share
  if (EXPLICIT_REQUEST_INDIC.some((p) => p.test(text))) {
    return { shouldShare: true, reason: "asked" };
  }

  // "Another" / "more" detection: if we recently shared content and user asks for more
  // Check if any recent assistant message contains "[shared:" (content was sent)
  if (recentHistory) {
    const recentAssistant = recentHistory
      .filter((m) => m.role === "assistant")
      .slice(-5);
    const recentlyShared = recentAssistant.some((m) => m.content.includes("[shared:"));
    if (recentlyShared) {
      // Lower threshold for "another" patterns when we recently shared
      const anotherPatterns = [
        /\b(another|more|again|one more|next|ek aur|aur ek|ar ekta|arekta|aur bhej|aur pathao|r ekta|aaro)\b/i,
        /\b(pathao|bhej|send|show|de|dao|dena)\b/i,  // Any "send" word after recent share
        /^(plz|pls|please|hasi|😂|🤣|💀|wow|lol|lmao)/i,  // Reaction + implied "more"
      ];
      if (anotherPatterns.some((p) => p.test(text))) {
        return { shouldShare: true, reason: "asked" };
      }
    }
  }

  // Vibe check — user is laughing a lot or mentions memes
  const vibeMatch = MEME_TRIGGER_PATTERNS.some((p) => p.test(text));
  if (vibeMatch && Math.random() < 0.25) {
    return { shouldShare: true, reason: "vibe" };
  }

  // Random share — small chance during natural conversation
  // Higher when Meera is in "bored" or "excited" mood
  let randomChance = 0.03;  // 3% base
  if (mood === "bored") randomChance = 0.08;
  if (mood === "excited") randomChance = 0.06;
  if (tier === "close") randomChance *= 1.5;  // Close friends share more

  if (Math.random() < randomChance) {
    return { shouldShare: true, reason: "random" };
  }

  return { shouldShare: false, reason: "random" };
}
