'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../js/core.js');

test('parseCards accepts dash, equals, tab and skips lines without translation', () => {
  const { cards, errors } = C.parseCards('apple — яблоко\nwell-known - известный\nrun=бежать\nbook\tкнига\n\nnothing here');

  assert.deepStrictEqual(cards, [
    { en: 'apple', ru: 'яблоко' },
    { en: 'well-known', ru: 'известный' },
    { en: 'run', ru: 'бежать' },
    { en: 'book', ru: 'книга' },
  ]);
  assert.deepStrictEqual(errors, [{ line: 6, text: 'nothing here' }]);
});

test('serializeCards round-trips through parseCards', () => {
  const cards = [{ en: 'to run', ru: 'бежать, бегать' }, { en: 'state-of-the-art', ru: 'передовой' }];
  assert.deepStrictEqual(C.parseCards(C.serializeCards(cards)).cards, cards);
});

test('mergeCards keeps progress of existing words and gives unique ids', () => {
  const old = [{ id: 'a', en: 'Apple', ru: 'яблоко', level: 4 }];
  const merged = C.mergeCards(old, [{ en: 'apple', ru: 'яблоко, яблоня' }, { en: 'apple', ru: 'дубль' }]);

  assert.strictEqual(merged[0].id, 'a');
  assert.strictEqual(merged[0].level, 4);
  assert.strictEqual(merged[0].ru, 'яблоко, яблоня');
  assert.notStrictEqual(merged[1].id, 'a');
  assert.strictEqual(merged[1].level, 0);
});

test('checkAnswer accepts any variant, ignores case, ё, articles and parentheses', () => {
  assert.strictEqual(C.checkAnswer('Бегать', 'бежать, бегать'), 'correct');
  assert.strictEqual(C.checkAnswer('еж', 'ёж'), 'correct');
  assert.strictEqual(C.checkAnswer('run', 'to run'), 'correct');
  assert.strictEqual(C.checkAnswer('the apple', 'apple'), 'correct');
  assert.strictEqual(C.checkAnswer('ключ', 'ключ (от двери)'), 'correct');
  assert.strictEqual(C.checkAnswer('well known', 'well-known'), 'correct');
});

test('checkAnswer tolerates small typos only in long words', () => {
  assert.strictEqual(C.checkAnswer('beautifull', 'beautiful'), 'typo');
  assert.strictEqual(C.checkAnswer('horse', 'house'), 'wrong');
  assert.strictEqual(C.checkAnswer('', 'house'), 'wrong');
  assert.strictEqual(C.checkAnswer('cat', 'dog'), 'wrong');
});

test('grade raises level on success and drops it on mistake', () => {
  const card = { level: 0 };
  C.grade(card, true);
  C.grade(card, true);
  C.grade(card, true);
  assert.strictEqual(card.level, 3);
  assert.ok(C.isLearned(card));

  C.grade(card, false);
  assert.strictEqual(card.level, 1);
  assert.ok(!C.isLearned(card));
});

test('buildQuestion makes unique choice options including the answer', () => {
  const pool = [
    { id: '1', en: 'apple', ru: 'яблоко' },
    { id: '2', en: 'pear', ru: 'груша' },
    { id: '3', en: 'plum', ru: 'слива' },
    { id: '4', en: 'fruit', ru: 'Яблоко' },
    { id: '5', en: 'cherry', ru: 'вишня' },
  ];
  for (let i = 0; i < 50; i++) {
    const question = C.buildQuestion(pool[0], 'choice', pool, 'en-ru');
    assert.strictEqual(question.options.length, 4);
    assert.ok(question.options.includes('яблоко'));
    assert.ok(!question.options.includes('Яблоко'));
  }
});

test('buildQuestion true/false shows a real wrong answer when false', () => {
  const pool = [{ id: '1', en: 'apple', ru: 'яблоко' }, { id: '2', en: 'pear', ru: 'груша' }];
  for (let i = 0; i < 50; i++) {
    const question = C.buildQuestion(pool[0], 'tf', pool, 'ru-en');
    assert.strictEqual(question.prompt, 'яблоко');
    assert.strictEqual(question.shown, question.isTrue ? 'apple' : 'pear');
  }
});

test('learn session requires choice then write and requeues mistakes', () => {
  const cards = [{ id: '1', en: 'a1', ru: 'б1', level: 0 }, { id: '2', en: 'a2', ru: 'б2', level: 0 }];
  const session = C.createSession(cards, 'learn');
  const types = [];

  C.submit(session, false);
  assert.strictEqual(session.queue.length, 2);

  while (session.queue.length) {
    types.push(C.currentType(session));
    C.submit(session, true);
  }

  assert.deepStrictEqual(types.sort(), ['choice', 'choice', 'write', 'write']);
  assert.strictEqual(session.finished, 2);
  assert.strictEqual(C.sessionProgress(session), 1);
  assert.strictEqual(session.items.filter(item => item.misses).length, 1);
});

test('rankVoices keeps English voices and puts natural ones before robotic', () => {
  const voices = [
    { name: 'Milena', lang: 'ru-RU' },
    { name: 'Fred', lang: 'en-US' },
    { name: 'Eddy (English (US))', lang: 'en-US' },
    { name: 'Samantha', lang: 'en-US' },
    { name: 'Google UK English Female', lang: 'en-GB' },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US' },
    { name: 'Ava (Premium)', lang: 'en_US' },
  ];

  assert.deepStrictEqual(C.rankVoices(voices).map(voice => voice.name), [
    'Ava (Premium)',
    'Microsoft Aria Online (Natural) - English (United States)',
    'Google UK English Female',
    'Samantha',
    'Eddy (English (US))',
    'Fred',
  ]);
});

test('mix session asks random quiz types and finishes each card after one correct answer', () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ id: String(i), en: `w${i}`, ru: `с${i}`, level: 0 }));
  const session = C.createSession(cards, 'mix');
  const types = new Set();

  while (session.queue.length) {
    types.add(C.currentType(session));
    C.submit(session, true);
  }

  assert.deepStrictEqual([...types].sort(), ['choice', 'tf', 'write']);
  assert.strictEqual(session.finished, 30);
  assert.strictEqual(C.sessionProgress(session), 1);
});
