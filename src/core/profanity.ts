/**
 * Profanity matching for Russian (мат) and English on recognized words.
 *
 * Russian obscenities are productive: one root yields hundreds of forms with prefixes and
 * suffixes (хуй → нахуй, охуенный, хуёвый; ебать → заебал, выебон, долбоёб, разъебай). So
 * Russian is matched by root patterns on a normalized word, with explicit guards against common
 * innocent words that contain the same letters (небо, хлеб, требовать, колебать, страхую,
 * сукно, бляха, мандарин, педикюр, …). English is matched by stems plus a short exact list for
 * words that are only offensive as whole words (cunt, dick).
 */

export interface Word {
  text: string;
  /** Seconds. */
  start: number;
  end: number;
}

export interface Hit extends Word {
  /** Normalized form that matched. */
  norm: string;
}

/** Lower-case, ё→е, Latin look-alikes inside Cyrillic words → Cyrillic, keep letters, '*' and '-'. */
export function normalizeWord(w: string): string {
  let s = w.toLowerCase().replace(/ё/g, 'е');
  if (/[а-я]/.test(s)) {
    // mixed-script spellings ("xуй", "пиздa") — map Latin homoglyphs to Cyrillic
    const map: Record<string, string> = { a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', x: 'х', y: 'у', k: 'к', m: 'м', t: 'т', b: 'в', h: 'н' };
    s = s.replace(/[aeopcxykmtbh]/g, (ch) => map[ch] ?? ch);
  }
  return s.replace(/[^a-zа-я*\-]/g, '').replace(/^-+|-+$/g, '');
}

// ───────────────────────────── Russian ─────────────────────────────

/** Vowel-final prefixes that attach directly: за-ебал, вы-ебон, у-ебок, недо-ебанный. */
const RU_EB_VOWEL_PREFIX = '(?:за|на|вы|у|до|по|при|пере|недо|про|разо|расо|подо|ото|обо|изо|во|со)';
/** Consonant-final prefixes need the hard sign: съебаться, отъебись, подъебка, разъебай, въебать. */
const RU_EB_HARD_PREFIX = '(?:с|от|под|раз|рас|об|из|вз|в|над|пред)ъ';

const RU_PATTERNS: RegExp[] = [
  // хуй, хуя, хуе-, хуи, хую, хуёвый, хуйня; with a prefix: нахуй, похуй, охуеть, ахуеть, нихуя,
  // схуяли. Only at the start / after a prefix: inside words "-хую" is an adjective ending
  // (тихую, сухую, плохую, глухую), and "страхую", "ухудшить", "выхухоль" are innocent.
  /^(?:не|ни|на|по|о|а|от|до|за|вы|при|рас|раз|под|с|об|пере|недо)?ху[йяеию]/,
  // пизда, пиздец, спиздить, распиздяй
  /пизд/,
  // ебать & co at the start of the word: ебать, ебало, ебаный, ёб, ебля, еблан, ебучий, ебашить
  /^е(?:б(?:а|у|е|л|н|ы|и|ш|ок|ыр|ар)|б$)/,
  // with a prefix: заебал, наебать, выебон, уебок, доебаться, проебать, съебаться, отъебись
  new RegExp(`^(?:не)?(?:${RU_EB_VOWEL_PREFIX}|${RU_EB_HARD_PREFIX})е[б]`),
  // compounds: долбоёб, мозгоёб, хитровыебанный, остоебенить
  /(?:долбо|мозго|хитровы|осто|разъ|въ)еб/,
  // бля, блядь, блять, блядство, выблядок; not "бляха", "бляшка"
  /^(?:вы|по|на|рас|раз)?бля(?:д|т|$)/,
  // мудак, мудила, мудозвон, мудачьё; not "мудрый", "мудрёный"
  /^муд(?:ак|ач|ил|озвон|оеб|ень|ня)/,
  // пидор, пидар, пидорас, пидр; not "пиджак", "пиданчик"
  /^пид(?:[оа]р|р)/,
  // педик (but not педикюр), педераст
  /^педик(?:и|а|у|ом|ов|ами)?$/,
  /^педераст/,
  // залупа, залупаться
  /залуп/,
  // гандон, гондон
  /^г[ао]нд[ао]н/,
  // шлюха
  /^шлюх/,
  // манда (but not мандарин, мандат, мандолина)
  /^манд(?:а|ы|у|е|ой|ах|ами|авошка|ец|еж)$/,
  // хер, херня, нахер, похер, херово; not "Херсон", "херувим", "хересом"
  /^(?:на|по|ни)?хер(?:$|а$|у$|ом$|ня|ни|ов|ач)/,
  // English swears as Whisper writes them in Russian mode: фак, факинг, мазафака; not "факт", "факел"
  /^(?:фак|факин|факинг|факю|фак-ю)$/,
  /^ма[зт][аеэ]р?фак/,
];

/** сука only as an insult; "сук" (a bough), "сукно", "сукровица" are innocent. */
const RU_EXACT = new Set([
  'сука', 'суки', 'суку', 'суке', 'сукой', 'сучка', 'сучки', 'сучку', 'сучке', 'сучкой',
  'сучара', 'сучары', 'сукин', 'сукина', 'сукины', 'сукиным', 'сукиных', 'сучий', 'сучье', 'сучьи',
]);

/** Innocent words that would otherwise trip a pattern. */
const RU_ALLOW = new Set(['ебонит', 'хуанхэ', 'хуан', 'хуана', 'хуану', 'хуаном', 'херес', 'хересом', 'хереса']);

export function isRussianProfane(norm: string): boolean {
  if (!norm || RU_ALLOW.has(norm) || /^ебург/.test(norm)) return false; // "Ебург" = Екатеринбург
  if (RU_EXACT.has(norm)) return true;
  return RU_PATTERNS.some((re) => re.test(norm));
}

// ───────────────────────────── English ─────────────────────────────

const EN_PATTERNS: RegExp[] = [
  /f+u+c+k/, // fuck, fucking, motherfucker, clusterfuck, fuckin
  /^(?:mother|mutha)?f(?:ck|kn)/, // fck, fcking, fkn (not "fuk": Fukushima, Fukuoka)
  /(?<!mi)shit/, // shit, bullshit, shitty; "mishit" is a sports term
  /bitch/,
  /^cunts?$/,
  /^(?:ass|arse)holes?$/,
  /^(?:dumb|jack|smart|bad)?ass(?:es)?$/,
  /^dickheads?$/,
  /^cocksuck/,
  /^(?:bastard|bastards)$/,
  /^(?:whore|whores|slut|sluts|twat|twats|wanker|wankers|pussy|pussies|faggot|faggots|nigger|niggers|nigga|niggas)$/,
  /^bollocks$/,
];

/** Plain "ass" (donkey) and "bad ass" are too ambiguous to beep in isolation. */
const EN_ALLOW = new Set(['ass', 'asses', 'badass', 'smartass']);

export function isEnglishProfane(norm: string, original = norm): boolean {
  if (!norm || EN_ALLOW.has(norm)) return false;
  // "dick" is a name (Philip K. Dick, Moby Dick): only lower-case forms count.
  if (/^dicks?$/.test(norm)) return /^\W*dicks?\W*$/.test(original);
  return EN_PATTERNS.some((re) => re.test(norm));
}

/** "f***", "б**дь", "s**t" — Whisper sometimes self-censors; a letter followed by asterisks is a hit. */
function isStarred(norm: string): boolean {
  return /^[a-zа-я]+\*+[a-zа-я]*$/.test(norm);
}

/** True when the recognized word (as Whisper wrote it, with punctuation) is profane. */
export function isProfane(word: string): boolean {
  const norm = normalizeWord(word);
  if (!norm) return false;
  if (isStarred(norm)) return true;
  // hyphenated compounds: check every part (ёб-твою-мать, mother-fucker)
  const parts = norm.includes('-') ? [norm.replace(/-/g, ''), ...norm.split('-')] : [norm];
  for (const p of parts) {
    if (!p) continue;
    if (/[а-я]/.test(p) ? isRussianProfane(p) : isEnglishProfane(p, word.trim())) return true;
  }
  return false;
}

/** Profane words among recognized words. */
export function findProfanity(words: Word[]): Hit[] {
  const out: Hit[] = [];
  for (const w of words) if (isProfane(w.text)) out.push({ ...w, norm: normalizeWord(w.text) });
  return out;
}
