/**
 * Simulated "currently playing" music for Meera.
 *
 * Real Spotify Web API requires per-user OAuth and a Spotify account on their
 * device — overkill for a bot persona. Instead we simulate from curated mood
 * playlists. Output looks identical to a Spotify "now playing" share.
 *
 * Free + zero infra. Picks a track that fits her current mood and time of day.
 */

interface Track {
  title: string;
  artist: string;
  /** Mood tags this track fits */
  moods: string[];
  /** Hours of day this track plays well: e.g. [22,23,0,1] = late night */
  hours?: number[];
  /** Optional Spotify URL (real, public) so she can actually share it */
  spotify?: string;
}

const TRACKS: Track[] = [
  // Late-night intimate / sad-soft
  { title: "Channa Mereya", artist: "Arijit Singh", moods: ["sad", "tired", "clingy"], hours: [22, 23, 0, 1, 2], spotify: "https://open.spotify.com/track/52xJxFP6TqMuO4Yt0eOkMz" },
  { title: "Tum Hi Ho", artist: "Arijit Singh", moods: ["sad", "clingy"], hours: [21, 22, 23, 0, 1], spotify: "https://open.spotify.com/track/56T36HnpYrAsJlBKIyzTHp" },
  { title: "Phir Bhi Tumko Chaahunga", artist: "Arijit Singh", moods: ["sad", "clingy", "tired"], hours: [22, 23, 0, 1] },
  { title: "Agar Tum Saath Ho", artist: "Alka Yagnik, Arijit Singh", moods: ["sad", "clingy"], hours: [21, 22, 23, 0] },
  { title: "Raabta", artist: "Arijit Singh", moods: ["clingy", "chill"], hours: [20, 21, 22, 23] },

  // Morning / fresh
  { title: "Subhanallah", artist: "Sonu Nigam, Shreya Ghoshal", moods: ["happy", "chill"], hours: [6, 7, 8, 9] },
  { title: "Ilahi", artist: "Arijit Singh", moods: ["happy", "excited", "chill"], hours: [7, 8, 9, 10, 11] },
  { title: "Senorita", artist: "Farhan, Hrithik, Abhay", moods: ["happy", "excited"], hours: [9, 10, 11, 12, 17, 18] },

  // Pump / gym / excited
  { title: "Malhari", artist: "Vishal Dadlani", moods: ["excited", "happy", "sassy"], hours: [6, 7, 17, 18, 19] },
  { title: "Sadda Haq", artist: "Mohit Chauhan", moods: ["sassy", "annoyed", "excited"] },
  { title: "Apna Time Aayega", artist: "DIVINE, Ranveer Singh", moods: ["excited", "sassy"] },
  { title: "Zinda", artist: "Siddharth Mahadevan", moods: ["excited", "happy"] },

  // Bored / casual hum
  { title: "Tera Yaar Hoon Main", artist: "Arijit Singh", moods: ["chill", "bored"] },
  { title: "Pal", artist: "Arijit Singh, Shreya Ghoshal", moods: ["chill", "happy"] },
  { title: "Kalank Title Track", artist: "Arijit Singh", moods: ["clingy", "sad"] },

  // English crossover (Gen-Z taste)
  { title: "Cruel Summer", artist: "Taylor Swift", moods: ["excited", "sassy", "happy"] },
  { title: "As It Was", artist: "Harry Styles", moods: ["chill", "bored", "sad"] },
  { title: "Until I Found You", artist: "Stephen Sanchez", moods: ["clingy", "chill"], hours: [21, 22, 23, 0] },
  { title: "Dandelions", artist: "Ruth B.", moods: ["clingy", "chill"], hours: [22, 23, 0] },
  { title: "Sunflower", artist: "Post Malone, Swae Lee", moods: ["happy", "chill"] },
  { title: "Blinding Lights", artist: "The Weeknd", moods: ["excited", "sassy"] },

  // Bengali (Kolkata flavor)
  { title: "Tomake Chai", artist: "Arijit Singh", moods: ["clingy", "chill"], hours: [20, 21, 22, 23] },
  { title: "Bojhena Shey Bojhena", artist: "Arijit Singh", moods: ["sad", "clingy"], hours: [22, 23, 0, 1] },
  { title: "Khujechi Toke", artist: "Anupam Roy", moods: ["chill", "clingy"] },

  // Indie / lofi
  { title: "Pasoori", artist: "Ali Sethi, Shae Gill", moods: ["chill", "happy", "sassy"] },
  { title: "O Bedardeya", artist: "Arijit Singh", moods: ["sad", "clingy"], hours: [21, 22, 23, 0] },
];

interface NowPlaying {
  track: Track;
  startedAt: number;
}

let current: NowPlaying | null = null;
const TRACK_LENGTH_MS = 3.5 * 60 * 1000;

function pickTrack(mood: string, hourIST: number): Track {
  const candidates = TRACKS.filter(t => {
    const moodOk = t.moods.includes(mood);
    const hourOk = !t.hours || t.hours.includes(hourIST);
    return moodOk && hourOk;
  });
  const pool = candidates.length ? candidates : TRACKS.filter(t => t.moods.includes(mood));
  const final = pool.length ? pool : TRACKS;
  return final[Math.floor(Math.random() * final.length)];
}

function getHourIST(): number {
  return parseInt(
    new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date()),
    10
  );
}

/** Returns the track Meera is "currently listening to" — refreshes every ~3.5 min */
export function getNowPlaying(mood: string): Track {
  const hour = getHourIST();
  if (!current || Date.now() - current.startedAt > TRACK_LENGTH_MS) {
    current = { track: pickTrack(mood, hour), startedAt: Date.now() };
  }
  return current.track;
}

export function getMusicContext(mood: string): string {
  const t = getNowPlaying(mood);
  return `\n\nCURRENTLY PLAYING IN YOUR HEADPHONES: "${t.title}" by ${t.artist}. Reference it casually only if music comes up.`;
}

/** When user asks "what are you listening to" — Meera shares it. */
export function formatNowPlayingShare(mood: string): { caption: string; url?: string } {
  const t = getNowPlaying(mood);
  const captions = [
    `"${t.title}" — ${t.artist} 🎧`,
    `abhi sun rahi: ${t.title} 🎵`,
    `${t.title} ka mood hai 🎶`,
    `headphones mein: ${t.title} by ${t.artist} 💕`,
  ];
  return {
    caption: captions[Math.floor(Math.random() * captions.length)],
    url: t.spotify,
  };
}
