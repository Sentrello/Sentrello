/**
 * A temporary password an administrator can read down a phone line.
 *
 * Four short words rather than a string of symbols, because this one is
 * spoken aloud or written on a sticky note before it is typed — and "was that
 * an l or a 1" is how somebody ends up locked out twice. Length carries the
 * strength instead: four words from this list is about 44 bits, which is far
 * more than the six-character thing an administrator would have invented, and
 * it only has to survive until the person changes it.
 *
 * No apostrophes, no homophones, nothing that sounds like another word on the
 * list when said quickly.
 */
const WORDS = [
  "anchor",
  "basket",
  "cotton",
  "dinner",
  "eagle",
  "fabric",
  "garden",
  "hammer",
  "island",
  "jacket",
  "kettle",
  "ladder",
  "magnet",
  "napkin",
  "orange",
  "pencil",
  "quarry",
  "ribbon",
  "saddle",
  "timber",
  "umbrella",
  "velvet",
  "walnut",
  "yellow",
  "zebra",
  "bridge",
  "candle",
  "diamond",
  "engine",
  "forest",
  "granite",
  "harbour",
  "indigo",
  "jigsaw",
  "kitchen",
  "lantern",
  "meadow",
  "nutmeg",
  "octave",
  "pebble",
  "rocket",
  "silver",
  "thistle",
  "violet",
  "willow",
  "yoghurt",
  "acorn",
  "beacon",
  "cobalt",
  "domino",
  "ember",
  "falcon",
  "gravel",
  "hollow",
  "ivory",
  "juniper",
];

/**
 * Crypto random, not `Math.random`.
 *
 * This is a credential. A predictable one is worse than a weak one, because
 * nobody would think to check.
 */
export function temporaryPassword(words = 4): string {
  const picked: string[] = [];
  const buffer = new Uint32Array(words);
  crypto.getRandomValues(buffer);
  for (let i = 0; i < words; i += 1) {
    const index = (buffer[i] ?? 0) % WORDS.length;
    picked.push(WORDS[index] ?? "anchor");
  }
  // Hyphens: most password fields accept them, they survive being read aloud,
  // and they keep the whole thing above any "at least 8 characters" rule.
  return picked.join("-");
}
