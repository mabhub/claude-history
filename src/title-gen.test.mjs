import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanGeneratedTitle, detectLanguage, buildSystemPrompt, describeExitFailure } from './title-gen.mjs';

test('detectLanguage: French text detected as fr despite technical English terms', () => {
  assert.equal(detectLanguage("Configuration d'un routeur de bordure Thread via ssh, avec diagnostic réseau"), 'fr');
  assert.equal(detectLanguage('On nettoie l\'historique des commits du fork avant de pousser'), 'fr');
});

test('detectLanguage: English text detected as en', () => {
  assert.equal(detectLanguage('Debugging a memory leak in the user session handler after the deploy'), 'en');
  assert.equal(detectLanguage('The build is broken and the tests are failing on CI'), 'en');
});

test('detectLanguage: French "a" (has) and "on" do not count as English', () => {
  assert.equal(detectLanguage('Le serveur a planté, on a relancé'), 'fr');
});

test('detectLanguage: counts accented words such as "où"', () => {
  // Without "où" this is a 0–1 tie lost to "the".
  assert.equal(detectLanguage('où the logs'), 'fr');
});

test('detectLanguage: defaults to fr when no function words match', () => {
  // No detectable function words → default to French (the user's language).
  assert.equal(detectLanguage('ssh deploy build'), 'fr');
  assert.equal(detectLanguage(''), 'fr');
});

test('buildSystemPrompt: pins the requested language into the instruction', () => {
  assert.match(buildSystemPrompt('fr'), /français/);
  assert.match(buildSystemPrompt('en'), /anglais/);
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

test('describeExitFailure: appends the last stderr line as the reason', () => {
  assert.equal(
    describeExitFailure(1, "warning: something\nerror: unknown option '- x'\n"),
    "claude a quitté avec le code 1 : error: unknown option '- x'",
  );
});

test('describeExitFailure: falls back to the bare exit code without stderr', () => {
  assert.equal(describeExitFailure(2, '  \n'), 'claude a quitté avec le code 2.');
});
