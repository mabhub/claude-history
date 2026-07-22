import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitlePrompt, cleanGeneratedTitle } from './title-gen.mjs';

test('buildTitlePrompt: embeds the context and the constraints', () => {
  const prompt = buildTitlePrompt('Refactor the auth module');
  assert.match(prompt, /Refactor the auth module/);
  assert.match(prompt, /titre/i);
  assert.match(prompt, /\b3\b.*\b10\b|10 mots/i); // word-count constraint mentioned
});

test('cleanGeneratedTitle: keeps the first non-empty line', () => {
  assert.equal(cleanGeneratedTitle('\n  Configurer le routeur Thread  \n\nblabla'), 'Configurer le routeur Thread');
});

test('cleanGeneratedTitle: strips surrounding quotes and trailing punctuation', () => {
  assert.equal(cleanGeneratedTitle('"Mon titre."'), 'Mon titre');
  assert.equal(cleanGeneratedTitle('« Autre titre ! »'), 'Autre titre');
  assert.equal(cleanGeneratedTitle('Titre simple…'), 'Titre simple');
});

test('cleanGeneratedTitle: empty input yields empty string', () => {
  assert.equal(cleanGeneratedTitle('   \n  '), '');
});
