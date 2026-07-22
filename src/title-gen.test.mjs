import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTitlePrompt, cleanGeneratedTitle } from './title-gen.mjs';

test('buildTitlePrompt: carries the context (instructions live in the system prompt)', () => {
  assert.equal(buildTitlePrompt('Refactor the auth module'), 'Refactor the auth module');
});

test('cleanGeneratedTitle: takes the last non-empty line (the real answer)', () => {
  // claude puts any preamble/reasoning first and the actual title last.
  assert.equal(cleanGeneratedTitle('\n  raisonnement…  \n\nConfigurer le routeur Thread'), 'Configurer le routeur Thread');
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

test('cleanGeneratedTitle: skips a prose preamble (no colon) and takes the title below', () => {
  // Real claude outputs: a chatty sentence, then the actual title on its own line.
  assert.equal(
    cleanGeneratedTitle('Titre court demandé.\n\nConfiguration routeur de bordure Thread'),
    'Configuration routeur de bordure Thread',
  );
  assert.equal(
    cleanGeneratedTitle('Voici un titre pour cette conversation :\n\nDiagnostic routeur Thread'),
    'Diagnostic routeur Thread',
  );
});

test('cleanGeneratedTitle: a clean single-line title is returned as-is', () => {
  assert.equal(cleanGeneratedTitle('Configuration routeur Thread via ssh'), 'Configuration routeur Thread via ssh');
});

test('cleanGeneratedTitle: empty input yields empty string', () => {
  assert.equal(cleanGeneratedTitle('   \n  '), '');
});
