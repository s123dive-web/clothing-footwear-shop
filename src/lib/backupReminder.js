// Weekly backup reminder. Pure.
export const BACKUP_EVERY_DAYS = 7;
const DAY = 86400000;

// lastAt: ms timestamp of the last backup (or null/0 if never). → { days, due, text }
export function backupStatus(lastAt, now = Date.now()) {
  if (!lastAt) return { days: null, due: true, text: "Last backup: never" };
  const days = Math.max(0, Math.floor((now - lastAt) / DAY));
  const text =
    days === 0
      ? "Last backup: today"
      : days === 1
        ? "Last backup: yesterday"
        : `Last backup: ${days} days ago`;
  return { days, due: days >= BACKUP_EVERY_DAYS, text };
}
