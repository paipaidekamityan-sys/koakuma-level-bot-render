function xpForLevel(level) {
  return 5 * level * level + 50 * level + 100;
}

function levelFromXp(totalXp) {
  let level = 0;
  let remaining = Math.max(0, totalXp);
  while (remaining >= xpForLevel(level)) {
    remaining -= xpForLevel(level);
    level += 1;
  }
  return { level, currentXp: remaining, requiredXp: xpForLevel(level) };
}

function progressBar(current, required, size = 12) {
  const ratio = required <= 0 ? 1 : Math.min(1, current / required);
  const filled = Math.round(ratio * size);
  return "█".repeat(filled) + "░".repeat(size - filled);
}

module.exports = { levelFromXp, progressBar };
