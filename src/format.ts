import { EVENT_LABELS, type Revision } from './core/types';

/** `12 Mar 2026, 14:03:07` - unambiguous, sortable by eye. */
export function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return iso;
	}
	return date.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
}

/** Compact relative time used as the tree item description. */
export function formatRelative(iso: string, now: number = Date.now()): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) {
		return '';
	}
	const seconds = Math.max(0, Math.round((now - then) / 1000));
	if (seconds < 5) {
		return 'just now';
	}
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `${hours}h ago`;
	}
	const days = Math.round(hours / 24);
	if (days < 30) {
		return `${days}d ago`;
	}
	const months = Math.round(days / 30);
	if (months < 12) {
		return `${months}mo ago`;
	}
	return `${Math.round(months / 12)}y ago`;
}

export function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return '0 B';
	}
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

/** Label plus the honest qualifier for events that are easy to over-read. */
export function revisionLabel(revision: Revision): string {
	return EVENT_LABELS[revision.event] ?? revision.event;
}

export function shortHash(hash: string): string {
	return hash ? hash.slice(0, 8) : '—';
}

/** `path` relative to `base`, or `path` unchanged when it is not inside it. */
export function relativeOrAbsolute(base: string, target: string): string {
	if (target.startsWith(base)) {
		const rest = target.slice(base.length);
		return rest.replace(/^[\\/]+/, '');
	}
	return target;
}
