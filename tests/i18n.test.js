'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/shared/i18n.js');

const LANGUAGES = ['en', 'it', 'fr', 'es'];

function placeholders(text) {
  return (text.match(/\{\d+\}/g) || []).sort().join(',');
}

test('every language has exactly the English keys', () => {
  const englishKeys = Object.keys(i18n.MESSAGES.en).sort();
  for (const language of LANGUAGES) {
    assert.deepEqual(Object.keys(i18n.MESSAGES[language]).sort(), englishKeys, language);
  }
});

test('every translation keeps the placeholders of the English text', () => {
  for (const [key, english] of Object.entries(i18n.MESSAGES.en)) {
    for (const language of LANGUAGES) {
      assert.equal(placeholders(i18n.MESSAGES[language][key]), placeholders(english), `${language}.${key}`);
    }
  }
});

test('every translation is non-empty', () => {
  for (const language of LANGUAGES) {
    for (const [key, text] of Object.entries(i18n.MESSAGES[language])) {
      assert.ok(typeof text === 'string' && text.trim().length > 0, `${language}.${key}`);
    }
  }
});

test('pickLanguage uses the first supported candidate and falls back to English', () => {
  assert.equal(i18n.pickLanguage(['it-IT', 'en']), 'it');
  assert.equal(i18n.pickLanguage(['', 'de-DE', 'fr_FR']), 'fr');
  assert.equal(i18n.pickLanguage(['de-DE']), 'en');
  assert.equal(i18n.pickLanguage([]), 'en');
  assert.equal(i18n.pickLanguage(['__proto__']), 'en');
});

test('translator fills placeholders and falls back to the key', () => {
  const t = i18n.translator('it');
  assert.equal(t('version', '1.0.0'), 'Versione 1.0.0');
  assert.equal(t('stepDoneBroker', 14), '✓ 14 transazioni');
  assert.equal(t('missingKey'), 'missingKey');
  assert.equal(i18n.translator('xx')('close'), 'Close');
});

test('the risk notice cites the contract clause in every language', () => {
  for (const language of LANGUAGES) {
    assert.match(i18n.MESSAGES[language].riskText, /§4\.5/, language);
  }
});
