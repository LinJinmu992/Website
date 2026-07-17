const recent = document.querySelector<HTMLElement>('.recent');
const page = document.querySelector<HTMLElement>('.page');
const preview = document.querySelector<HTMLElement>('.article-preview');
const postList = document.querySelector<HTMLElement>('.post-list');
const closeButton = document.querySelector<HTMLButtonElement>('.preview-close');
const desktop = window.matchMedia('(min-width: 900px)');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let previewSwitchId = 0;
let handoffTarget: number | null = null;
let handoffFrame = 0;
let handoffTime = 0;

const stopHandoff = () => {
	if (handoffFrame) window.cancelAnimationFrame(handoffFrame);
	handoffFrame = 0;
	handoffTarget = null;
	handoffTime = 0;
};

const animateHandoff = (time: number) => {
	if (handoffTarget === null) {
		handoffFrame = 0;
		return;
	}

	const current = window.scrollY;
	const distance = handoffTarget - current;
	if (Math.abs(distance) < .5) {
		window.scrollTo({ top: handoffTarget, behavior: 'instant' as ScrollBehavior });
		stopHandoff();
		return;
	}

	const elapsed = handoffTime ? Math.min(time - handoffTime, 32) : 16;
	handoffTime = time;
	const easing = 1 - Math.exp(-elapsed / 70);
	window.scrollTo({
		top: current + distance * easing,
		behavior: 'instant' as ScrollBehavior,
	});
	handoffFrame = window.requestAnimationFrame(animateHandoff);
};

const scrollPageBy = (delta: number) => {
	const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
	const origin = handoffTarget ?? window.scrollY;
	handoffTarget = Math.min(max, Math.max(0, origin + delta));

	if (reducedMotion.matches) {
		window.scrollTo({ top: handoffTarget, behavior: 'instant' as ScrollBehavior });
		stopHandoff();
	} else if (!handoffFrame) {
		handoffFrame = window.requestAnimationFrame(animateHandoff);
	}
};

function closePreview() {
	previewSwitchId++;
	stopHandoff();
	recent?.classList.remove('is-reading');
	page?.classList.remove('reading-mode');
	document.querySelectorAll('[data-post]').forEach((item) => item.removeAttribute('data-active'));
	document.querySelectorAll<HTMLElement>('[data-preview-active]').forEach((item) => {
		item.removeAttribute('data-preview-active');
	});
	window.setTimeout(() => {
		if (!recent?.classList.contains('is-reading')) {
			document.querySelectorAll<HTMLElement>('[data-preview]').forEach((item) => {
				item.hidden = true;
				item.classList.remove('preview-enter', 'preview-leave');
			});
		}
	}, 450);
}

document.querySelectorAll<HTMLAnchorElement>('[data-preview-link]').forEach((link) => {
	link.addEventListener('click', (event) => {
		if (!desktop.matches) return;
		event.preventDefault();
		const slug = link.dataset.previewLink;
		if (!slug) return;

		const currentPreview = document.querySelector<HTMLElement>('[data-preview-active], .preview-leave');
		const nextPreview = document.querySelector<HTMLElement>(`[data-preview="${slug}"]`);
		if (!nextPreview || currentPreview === nextPreview) return;
		const switchId = ++previewSwitchId;

		document.querySelectorAll<HTMLElement>('[data-preview]').forEach((item) => {
			if (item !== currentPreview && item !== nextPreview) {
				item.hidden = true;
				item.classList.remove('preview-enter', 'preview-leave');
				item.removeAttribute('data-preview-active');
			}
		});

		const showNextPreview = () => {
			if (switchId !== previewSwitchId) return;
			nextPreview.hidden = false;
			nextPreview.classList.remove('preview-enter', 'preview-leave');
			void nextPreview.offsetWidth;
			nextPreview.setAttribute('data-preview-active', '');
			nextPreview.classList.add('preview-enter');
			preview?.scrollTo({ top: 0, behavior: 'smooth' });
		};

		if (currentPreview) {
			currentPreview.removeAttribute('data-preview-active');
			currentPreview.classList.remove('preview-enter');
			currentPreview.classList.add('preview-leave');
			window.setTimeout(() => {
				if (!currentPreview.hasAttribute('data-preview-active')) {
					currentPreview.hidden = true;
					currentPreview.classList.remove('preview-leave');
				}
				showNextPreview();
			}, 230);
		} else {
			showNextPreview();
		}

		document.querySelectorAll<HTMLElement>('[data-post]').forEach((item) => {
			if (item.dataset.post === slug) item.setAttribute('data-active', '');
			else item.removeAttribute('data-active');
		});
		page?.classList.add('reading-mode');
		recent?.classList.add('is-reading');
	});
});

closeButton?.addEventListener('click', closePreview);
desktop.addEventListener('change', (event) => {
	if (!event.matches) closePreview();
});

const atTop = (element: HTMLElement) => element.scrollTop <= 1;
const atBottom = (element: HTMLElement) =>
	element.scrollTop + element.clientHeight >= element.scrollHeight - 1;

[postList, preview].forEach((scroller) => {
	scroller?.addEventListener('wheel', (event) => {
		if (!recent?.classList.contains('is-reading')) return;

		const unit =
			event.deltaMode === WheelEvent.DOM_DELTA_LINE
				? 36
				: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
					? window.innerHeight
					: 1;
		const delta = event.deltaY * unit;
		const startsAtBoundary =
			(delta < 0 && atTop(scroller)) ||
			(delta > 0 && atBottom(scroller));

		if (!startsAtBoundary) {
			stopHandoff();
			return;
		}

		if (Math.abs(delta) > .1) scrollPageBy(delta);
	}, { passive: true });
});

window.addEventListener('wheel', (event) => {
	const target = event.target;
	const insidePane =
		target instanceof Node &&
		(postList?.contains(target) || preview?.contains(target));
	if (!insidePane) stopHandoff();
}, { capture: true, passive: true });
