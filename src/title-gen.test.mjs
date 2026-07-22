import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitlePrompt, cleanGeneratedTitle } from './title-gen.mjs';

test('buildTitlePrompt: carries the context (instructions live in the system prompt)', () => {
  assert.equal(buildTitlePrompt('Refactor the auth module'), 'Refactor the auth module');
});

test('cleanGeneratedTitle: keeps the first non-empty line', () => {
  assert.equal(cleanGeneratedTitle('\n  Configurer le routeur Thread  \n\nblabla'), 'Configurer le routeur Thread');
});

test('cleanGeneratedTitle: strips surrounding quotes and trailing punctuation', () => {
  assert.equal(cleanGeneratedTitle('"Mon titre."'), 'Mon titre');
  assert.equal(cleanGeneratedTitle('« Autre titre ! »'), 'Autre titre');
  assert.equal(cleanGeneratedTitle('Titre simple…'), 'Titre simple');
});

test('cleanGeneratedTitle: strips a "Titre :" preamble on the same line', () => {
  assert.equal(cleanGeneratedTitle('Titre : Mon vrai titre'), 'Mon vrai titre');
  assert.equal(cleanGeneratedTitle('Title: Some title'), 'Some title');
});

test('cleanGeneratedTitle: skips a preamble-only line and takes the real title below', () => {
  assert.equal(cleanGeneratedTitle('Titre :\n\nConfigurer le routeur Thread'), 'Configurer le routeur Thread');
});

test('cleanGeneratedTitle: empty input yields empty string', () => {
  assert.equal(cleanGeneratedTitle('   \n  '), '');
});
