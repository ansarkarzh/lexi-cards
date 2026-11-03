(function (root) {
  'use strict';

  const LEARNED_LEVEL = 2;
  const MAX_LEVEL = 5;
  const REQUEUE_GAP = 3;
  const MIX_TYPES = ['choice', 'write', 'tf'];
  const SEPARATORS = [/\t+/, /\s+[-–—=:]\s+/, /[–—=]/];
  const FILLER_WORDS = new Set(['будет', 'будут', 'быть', 'это', 'ли', 'же', 'бы', 'то', 'вот', 'и', 'a', 'an', 'the', 'to', 'be', 'will', 'is', 'are']);
  const WORD_PREFIX_MIN = 4;
  const WORD_PREFIX_SHARE = 0.6;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function shuffle(items) {
    const result = items.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function parseCards(text) {
    const cards = [];
    const errors = [];

    text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (!line) {
        return;
      }

      for (const separator of SEPARATORS) {
        const match = line.match(separator);
        if (!match) {
          continue;
        }

        const en = line.slice(0, match.index).trim();
        const ru = line.slice(match.index + match[0].length).trim();
        if (en && ru) {
          cards.push({ en, ru });
          return;
        }
      }

      errors.push({ line: index + 1, text: line });
    });

    return { cards, errors };
  }

  function serializeCards(cards) {
    return cards.map(card => `${card.en} — ${card.ru}`).join('\n');
  }

  function mergeCards(oldCards, parsed) {
    const byEn = new Map(oldCards.map(card => [card.en.toLowerCase(), card]));

    return parsed.map(pair => {
      const key = pair.en.toLowerCase();
      const old = byEn.get(key);
      if (!old) {
        return { id: uid(), en: pair.en, ru: pair.ru, level: 0 };
      }

      byEn.delete(key);
      return { ...old, en: pair.en, ru: pair.ru };
    });
  }

  function normalize(text) {
    return text
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[’`]/g, "'")
      .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripArticles(text) {
    return text.replace(/^(to|a|an|the) /, '');
  }

  function answerVariants(expected) {
    const withoutParens = expected.replace(/\([^)]*\)/g, ' ');
    const raw = [expected, withoutParens, ...withoutParens.split(/[,;/]/)];
    const variants = new Set();

    raw.forEach(item => {
      const variant = stripArticles(normalize(item));
      if (variant) {
        variants.add(variant);
      }
    });

    return [...variants];
  }

  function levenshtein(a, b) {
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost));
      }
      previous = current;
    }

    return previous[b.length];
  }

  function typoLimit(length) {
    if (length >= 10) {
      return 2;
    }
    return length >= 6 ? 1 : 0;
  }

  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) {
      i++;
    }
    return i;
  }

  // Russian words change endings with case and tense, so a long shared beginning counts as the same word.
  function sameWord(a, b) {
    if (levenshtein(a, b) <= typoLimit(Math.max(a.length, b.length))) {
      return true;
    }
    const prefix = commonPrefix(a, b);
    return prefix >= WORD_PREFIX_MIN && prefix / Math.max(a.length, b.length) >= WORD_PREFIX_SHARE;
  }

  function contentWords(text) {
    return text.split(' ').filter(word => !FILLER_WORDS.has(word));
  }

  function sameWords(answer, variant) {
    const words = contentWords(answer);
    const rest = contentWords(variant);
    if (!words.length || words.length !== rest.length) {
      return false;
    }

    return words.every(word => {
      const index = rest.findIndex(other => sameWord(word, other));
      if (index < 0) {
        return false;
      }
      rest.splice(index, 1);
      return true;
    });
  }

  function checkAnswer(input, expected, accepted = []) {
    const answer = stripArticles(normalize(input));
    if (!answer) {
      return 'wrong';
    }

    const variants = [...answerVariants(expected), ...accepted];
    if (variants.includes(answer)) {
      return 'correct';
    }
    if (variants.some(variant => levenshtein(answer, variant) <= typoLimit(variant.length))) {
      return 'typo';
    }
    return variants.some(variant => sameWords(answer, variant)) ? 'close' : 'wrong';
  }

  function acceptAnswer(card, lang, input) {
    const answer = stripArticles(normalize(input));
    const accepted = card.accepted || {};
    const list = accepted[lang] || [];
    if (answer && !list.includes(answer)) {
      card.accepted = { ...accepted, [lang]: [...list, answer] };
    }
  }

  function grade(card, ok) {
    const level = card.level || 0;
    card.level = ok ? Math.min(MAX_LEVEL, level + 1) : Math.max(0, level - 2);
  }

  function isLearned(card) {
    return (card.level || 0) >= LEARNED_LEVEL;
  }

  function levelStats(cards) {
    const stats = { fresh: 0, learning: 0, learned: 0 };
    cards.forEach(card => {
      if (isLearned(card)) {
        stats.learned++;
      } else if ((card.level || 0) > 0) {
        stats.learning++;
      } else {
        stats.fresh++;
      }
    });
    return stats;
  }

  function resolveDirection(direction) {
    if (direction !== 'mix') {
      return direction;
    }
    return Math.random() < 0.5 ? 'en-ru' : 'ru-en';
  }

  function sides(card, direction) {
    const dir = resolveDirection(direction);
    if (dir === 'en-ru') {
      return { dir, prompt: card.en, answer: card.ru, promptLang: 'en', answerLang: 'ru' };
    }
    return { dir, prompt: card.ru, answer: card.en, promptLang: 'ru', answerLang: 'en' };
  }

  function answerOf(card, dir) {
    return dir === 'en-ru' ? card.ru : card.en;
  }

  function buildQuestion(card, type, pool, direction) {
    const question = { card, type, ...sides(card, direction) };
    const others = shuffle(pool.filter(other => other.id !== card.id));
    const isSameAnswer = text => normalize(text) === normalize(question.answer);

    if (type === 'choice') {
      const options = [question.answer];
      for (const other of others) {
        if (options.length >= 4) {
          break;
        }
        const option = answerOf(other, question.dir);
        if (!options.some(existing => normalize(existing) === normalize(option))) {
          options.push(option);
        }
      }
      question.options = shuffle(options);
    }

    if (type === 'tf') {
      const wrong = others.map(other => answerOf(other, question.dir)).find(text => !isSameAnswer(text));
      question.isTrue = !wrong || Math.random() < 0.5;
      question.shown = question.isTrue ? question.answer : wrong;
    }

    return question;
  }

  function stagesFor(mode) {
    return mode === 'learn' ? ['choice', 'write'] : [mode];
  }

  function createSession(cards, mode) {
    const items = shuffle(cards).map(card => ({
      card,
      stage: mode === 'learn' && (card.level || 0) >= 1 ? 1 : 0,
      misses: 0,
    }));
    return { mode, items, queue: items.slice(), total: items.length, finished: 0, correct: 0, wrong: 0 };
  }

  function currentType(session) {
    if (session.mode === 'mix') {
      return MIX_TYPES[Math.floor(Math.random() * MIX_TYPES.length)];
    }
    return stagesFor(session.mode)[session.queue[0].stage];
  }

  function submit(session, ok) {
    const item = session.queue.shift();

    if (!ok) {
      session.wrong++;
      item.misses++;
      session.queue.splice(Math.min(REQUEUE_GAP, session.queue.length), 0, item);
      return;
    }

    session.correct++;
    item.stage++;
    if (item.stage >= stagesFor(session.mode).length) {
      session.finished++;
      return;
    }
    session.queue.push(item);
  }

  function sessionProgress(session) {
    if (!session.total) {
      return 1;
    }
    const done = session.items.reduce((sum, item) => sum + item.stage, 0);
    return done / (session.total * stagesFor(session.mode).length);
  }

  const NOVELTY_VOICES = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|fred|good news|hysterical|jester|junior|kathy|organ|pipe organ|princess|ralph|superstar|trinoids|whisper|wobble|zarvox)\b/i;
  const ELOQUENCE_VOICES = /^(eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
  const GOOD_SYSTEM_VOICES = /^(samantha|daniel|karen|moira|ava|allison|susan|serena|tom|alex)\b/i;

  function voiceScore(voice) {
    const name = voice.name;
    const lang = voice.lang.replace('_', '-').toLowerCase();
    let score = 0;

    if (/natural|neural/i.test(name)) {
      score += 50;
    }
    if (/premium/i.test(name)) {
      score += 40;
    }
    if (/enhanced/i.test(name)) {
      score += 35;
    }
    if (/^google/i.test(name)) {
      score += 30;
    }
    if (GOOD_SYSTEM_VOICES.test(name)) {
      score += 15;
    }
    if (NOVELTY_VOICES.test(name)) {
      score -= 100;
    }
    if (ELOQUENCE_VOICES.test(name)) {
      score -= 30;
    }
    if (lang === 'en-us') {
      score += 5;
    } else if (lang === 'en-gb') {
      score += 4;
    }

    return score;
  }

  function rankVoices(voices) {
    return voices
      .filter(voice => /^en([-_]|$)/i.test(voice.lang))
      .map(voice => ({ voice, score: voiceScore(voice) }))
      .sort((a, b) => b.score - a.score)
      .map(item => item.voice);
  }

  const Core = {
    MAX_LEVEL,
    rankVoices,
    uid,
    shuffle,
    parseCards,
    serializeCards,
    mergeCards,
    normalize,
    checkAnswer,
    acceptAnswer,
    grade,
    isLearned,
    levelStats,
    sides,
    buildQuestion,
    createSession,
    currentType,
    submit,
    sessionProgress,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Core;
  } else {
    root.Core = Core;
  }
})(this);
