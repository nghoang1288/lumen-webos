import {useEffect, useState} from 'preact/hooks';
import {TIMING} from '../config/constants';

/** Current time, re-rendered once a second (only changes when the minute changes
 *  matter to the UI, but a 1s tick keeps the displayed minute exact). */
export function useClock (): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		let id = 0;
		const tick = () => setNow(new Date());
		const start = () => {
			if (id) window.clearInterval(id);
			if (!document.hidden) {
				tick();
				id = window.setInterval(tick, TIMING.clockTickMs);
			}
		};
		start();
		document.addEventListener('visibilitychange', start);
		return () => {
			if (id) window.clearInterval(id);
			document.removeEventListener('visibilitychange', start);
		};
	}, []);
	return now;
}
