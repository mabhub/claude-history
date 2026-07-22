/**
 * Build the prompt sent to `claude -p` to title a conversation. Kept pure so it
 * can be unit-tested without spawning anything.
 * @param {string} context - away_summary or a fallback excerpt of the conversation
 * @returns {string} Prompt text
 */
export const buildTitlePrompt = context =>
  [
    'Génère un titre court et descriptif pour cette conversation.',
    'Contraintes : 3 à 10 mots, pas de ponctuation finale, pas de guillemets,',
    'même langue que le contenu. Réponds UNIQUEMENT par le titre, rien d\'autre.',
    '',
    'Contenu :',
    context,
  ].join('\n');

/**
 * Normalize `claude -p` stdout into a clean title: first non-empty line,
 * trimmed, with surrounding quotes and trailing sentence punctuation removed.
 * @param {string} stdout - Raw stdout from claude
 * @returns {string} Cleaned title (may be empty)
 */
export const cleanGeneratedTitle = stdout => {
  const firstLine = stdout.split('\n').map(l => l.trim()).find(Boolean) ?? '';
  // Strip a single layer of surrounding straight or French quotes.
  const unquoted = firstLine.replace(/^["'«»]\s*/, '').replace(/\s*["'«»]$/, '').trim();
  // Drop trailing sentence punctuation (and any space left before it).
  return unquoted.replace(/[.!?…]+$/, '').trim();
};
