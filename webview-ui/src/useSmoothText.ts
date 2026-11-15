import { useEffect, useRef, useState } from 'react';

const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;

/** Time to catch up with whatever has arrived but isn't shown yet. */
const CATCH_UP_MS = 120;

/**
 * While `active`, reveals `target` a few characters per frame instead of in network-sized chunks,
 * so streaming text flows smoothly. Returns the full text when inactive or with reduced motion.
 */
export function useSmoothText(target: string, active: boolean): string {
	const smooth = active && !reducedMotion?.matches;
	const shownRef = useRef(target.length);
	const targetRef = useRef(target);
	targetRef.current = target;
	const [, setFrame] = useState(0);

	useEffect(() => {
		if (!smooth) {
			return;
		}
		let raf = 0;
		let last = performance.now();
		const tick = (now: number) => {
			const full = targetRef.current.length;
			if (shownRef.current > full) {
				shownRef.current = full;
			}
			const backlog = full - shownRef.current;
			if (backlog > 0) {
				const step = Math.max(1, Math.ceil(backlog * Math.min(1, (now - last) / CATCH_UP_MS)));
				shownRef.current = Math.min(full, shownRef.current + step);
				setFrame(f => f + 1);
			}
			last = now;
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [smooth]);

	return smooth ? target.slice(0, shownRef.current) : target;
}
