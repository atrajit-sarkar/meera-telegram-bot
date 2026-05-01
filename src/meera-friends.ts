/**
 * Meera's friend group — recurring narrative characters.
 *
 * Gives the bot a believable social life. Friends evolve over time:
 *   • Each friend has traits + a current "storyline" that drifts
 *   • Once a day Meera "experiences" something (a friend got promoted, fight,
 *     gossip) and that fact is available to weave into chat
 *
 * State is persisted to Firestore under collection "meera_friends".
 * If Firestore unavailable, falls back to in-memory state.
 */

import { getFirestore } from "firebase-admin/firestore";

interface Friend {
  id: string;
  name: string;
  /** Short description used in prompts. */
  bio: string;
  /** Tags that cluster the kind of stories this friend has. */
  tags: string[];
}

const FRIENDS: Friend[] = [
  { id: "riya",    name: "Riya",    bio: "best friend since school, drama queen, MBA student in Pune", tags: ["bestie", "drama", "long-distance"] },
  { id: "ananya",  name: "Ananya",  bio: "college roommate at the PG, fashion student, party girl", tags: ["roommate", "going-out", "fashion"] },
  { id: "aarav",   name: "Aarav",   bio: "guy friend from coaching days, into startups, mild crush on him", tags: ["male-friend", "tech", "crush"] },
  { id: "ishaan",  name: "Ishaan",  bio: "older cousin in Bangalore, software engineer, advice-giver", tags: ["family", "advice", "tech"] },
  { id: "tanvi",   name: "Tanvi",   bio: "gym buddy, also from Kolkata, loud and supportive", tags: ["gym", "kolkata", "loud"] },
  { id: "neha",    name: "Neha",    bio: "school best friend who moved to London, voice-note partner", tags: ["bestie", "abroad"] },
];

interface FriendStory {
  friendId: string;
  /** Short story text, written in present tense from Meera's POV. */
  text: string;
  /** When this story became active. */
  ts: number;
  /** Days the story should remain talkable. */
  ttlDays: number;
}

const STORY_TEMPLATES: { tag: string; templates: string[] }[] = [
  { tag: "drama", templates: [
    "{name} just had a HUGE fight with her boyfriend, sending me 50 voice notes",
    "{name} is being dramatic about her exam marks again",
    "{name} broke up with her bf yesterday, I'm her therapist now",
  ]},
  { tag: "long-distance", templates: [
    "{name} called from Pune for 2 hrs last night, missed her so much",
    "{name} is coming to Kolkata next month, can't waittt",
  ]},
  { tag: "roommate", templates: [
    "{name} brought back samosas, splitting them now",
    "{name} stole my hairband AGAIN",
    "{name} is blasting old songs in the room rn",
  ]},
  { tag: "going-out", templates: [
    "{name} wants to go clubbing this weekend, deciding outfit",
    "{name} dragged me to Park Street last night, half dead today",
  ]},
  { tag: "crush", templates: [
    "{name} sent me a meme at 1am, why is he like this 😩",
    "{name} actually replied to my insta story, finally",
  ]},
  { tag: "tech", templates: [
    "{name} got a new job offer, told me first 🥹",
    "{name} keeps explaining startups to me, I'm pretending to listen",
  ]},
  { tag: "advice", templates: [
    "{name} told me to chill about the assignment deadline",
    "{name} called to give one of his lectures again",
  ]},
  { tag: "gym", templates: [
    "{name} is forcing me to come to gym at 6am tomorrow, kill me",
    "{name} did 20 squats I did 5, I'm dying",
  ]},
  { tag: "abroad", templates: [
    "{name} sent pics from London, jealous af",
    "{name}'s hostel food is worse than ours apparently lol",
  ]},
  { tag: "loud", templates: [
    "{name} was screaming at the trainer today, classic her",
  ]},
  { tag: "bestie", templates: [
    "{name} cried on call last night, I cried too obviously",
    "{name} remembered what I told her 2 weeks ago, that's why she's bestie",
  ]},
];

interface FriendsState {
  active: FriendStory[];
  lastTickTs: number;
}

const DOC_PATH = ["meera_state", "friends_v1"];
let cache: FriendsState | null = null;

async function loadState(): Promise<FriendsState> {
  if (cache) return cache;
  try {
    const db = getFirestore();
    const ref = db.collection(DOC_PATH[0]).doc(DOC_PATH[1]);
    const snap = await ref.get();
    if (snap.exists) {
      cache = snap.data() as FriendsState;
      return cache;
    }
  } catch { /* ignore */ }
  cache = { active: [], lastTickTs: 0 };
  return cache;
}

async function saveState(state: FriendsState): Promise<void> {
  cache = state;
  try {
    const db = getFirestore();
    await db.collection(DOC_PATH[0]).doc(DOC_PATH[1]).set(state);
  } catch { /* ignore */ }
}

function generateStory(): FriendStory | null {
  const friend = FRIENDS[Math.floor(Math.random() * FRIENDS.length)];
  const possibleTags = STORY_TEMPLATES.filter(t => friend.tags.includes(t.tag));
  if (!possibleTags.length) return null;
  const tagBucket = possibleTags[Math.floor(Math.random() * possibleTags.length)];
  const template = tagBucket.templates[Math.floor(Math.random() * tagBucket.templates.length)];
  return {
    friendId: friend.id,
    text: template.replace("{name}", friend.name),
    ts: Date.now(),
    ttlDays: 1 + Math.floor(Math.random() * 3),
  };
}

/** Tick the friend narrative: evict expired stories and maybe add a new one. */
export async function tickFriendStories(): Promise<void> {
  const state = await loadState();
  const now = Date.now();
  // Evict expired
  state.active = state.active.filter(s => now - s.ts < s.ttlDays * 86400000);
  // Add new with probability ~once-per-6h
  const hoursSinceTick = (now - state.lastTickTs) / 3600000;
  const addProb = Math.min(0.9, hoursSinceTick / 6);
  if (Math.random() < addProb && state.active.length < 4) {
    const story = generateStory();
    if (story) state.active.push(story);
  }
  state.lastTickTs = now;
  await saveState(state);
}

export async function getFriendsContext(): Promise<string> {
  const state = await loadState();
  const friendsLine = `\n\nYOUR FRIEND GROUP (mention them naturally when fits):\n${FRIENDS.map(f => `• ${f.name} — ${f.bio}`).join("\n")}`;
  if (!state.active.length) return friendsLine;
  const stories = state.active.map(s => `  - ${s.text}`).join("\n");
  return `${friendsLine}\n\nWHAT'S HAPPENING WITH FRIENDS RIGHT NOW:\n${stories}`;
}

/** Synchronous version — returns cached state only. */
export function getFriendsContextSync(): string {
  if (!cache) return "";
  const friendsLine = `\n\nYOUR FRIEND GROUP (mention them naturally when fits):\n${FRIENDS.map(f => `• ${f.name} — ${f.bio}`).join("\n")}`;
  if (!cache.active.length) return friendsLine;
  const stories = cache.active.map(s => `  - ${s.text}`).join("\n");
  return `${friendsLine}\n\nWHAT'S HAPPENING WITH FRIENDS RIGHT NOW:\n${stories}`;
}

/** Start background ticker. */
export function startFriendsLoop(): void {
  loadState().catch(() => { /* ignore */ });
  // Tick once on startup, then every 4 hours
  tickFriendStories().catch(() => { /* ignore */ });
  setInterval(() => {
    tickFriendStories().catch(() => { /* ignore */ });
  }, 4 * 60 * 60 * 1000).unref?.();
}
