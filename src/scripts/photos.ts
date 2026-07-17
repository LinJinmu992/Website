const lightbox = document.querySelector<HTMLDialogElement>('[data-photo-lightbox]');
const lightboxImage = document.querySelector<HTMLImageElement>('[data-lightbox-image]');
const lightboxCaption = document.querySelector<HTMLElement>('[data-lightbox-caption]');
const closeButton = document.querySelector<HTMLButtonElement>('[data-lightbox-close]');
const timeline = document.querySelector<HTMLElement>('.photo-timeline');
let closeTimer: number | undefined;

if (timeline && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
	const items = Array.from(timeline.querySelectorAll<HTMLElement>('.timeline-item'));
	const timelineHeight = Math.max(timeline.scrollHeight, 1);
	const drawDuration = Math.min(4000, Math.max(1200, timelineHeight * 1.2));
	const startDelay = 920;

	timeline.style.setProperty('--timeline-duration', `${drawDuration}ms`);
	timeline.style.setProperty('--timeline-start-delay', `${startDelay}ms`);
	items.forEach((item) => {
		const dot = item.querySelector<HTMLElement>('.timeline-dot');
		const dotCenter = item.offsetTop + (dot?.offsetTop ?? 0) + (dot?.offsetHeight ?? 0) / 2;
		const progress = Math.min(1, Math.max(0, dotCenter / timelineHeight));
		item.style.setProperty('--node-delay', `${startDelay + drawDuration * progress}ms`);
	});

	timeline.classList.add('is-animating');
}

const closeLightbox = () => {
	if (!lightbox?.open || lightbox.classList.contains('is-closing')) return;
	lightbox.classList.add('is-closing');
	closeTimer = window.setTimeout(() => lightbox.close(), 220);
};

document.querySelectorAll<HTMLAnchorElement>('[data-photo-open]').forEach((link) => {
	link.addEventListener('click', (event) => {
		event.preventDefault();
		if (!lightbox || !lightboxImage) return;
		const name = link.dataset.photoName || '摄影作品';
		lightboxImage.src = link.dataset.photoUrl || link.href;
		lightboxImage.alt = name;
		if (lightboxCaption) lightboxCaption.textContent = name;
		document.documentElement.classList.add('lightbox-open');
		lightbox.showModal();
	});
});

closeButton?.addEventListener('click', closeLightbox);
lightbox?.addEventListener('click', (event) => {
	if (event.target === lightbox) closeLightbox();
});
lightbox?.addEventListener('cancel', (event) => {
	event.preventDefault();
	closeLightbox();
});
lightbox?.addEventListener('close', () => {
	if (closeTimer) window.clearTimeout(closeTimer);
	closeTimer = undefined;
	lightbox.classList.remove('is-closing');
	document.documentElement.classList.remove('lightbox-open');
	if (lightboxImage) lightboxImage.src = '';
});
