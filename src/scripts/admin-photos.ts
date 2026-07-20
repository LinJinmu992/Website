import { adminApi as api, escapeHtml, initializeAdminSession, uploadImage, validateImageFile } from './admin-client';

const loginForm = document.querySelector<HTMLFormElement>('[data-login]');
const loginStatus = document.querySelector<HTMLElement>('[data-login-status]');
const logoutButton = document.querySelector<HTMLButtonElement>('[data-logout]');
const photoManager = document.querySelector<HTMLElement>('[data-photo-manager]');
const photoGrid = document.querySelector<HTMLElement>('[data-photo-grid]');
const photoImageInput = document.querySelector<HTMLInputElement>('[data-photo-image]');
const photoUploadStatus = document.querySelector<HTMLElement>('[data-photo-upload-status]');
const refreshPhotosButton = document.querySelector<HTMLButtonElement>('[data-refresh-photos]');

const setAuthed = (authed: boolean) => {
	if (loginForm) loginForm.hidden = authed;
	if (photoManager) photoManager.hidden = !authed;
	if (logoutButton) logoutButton.hidden = !authed;
};

const renderPhotos = (items: Array<{
	filename?: string;
	url: string;
	thumbnailUrl?: string;
	createdAt?: string;
}>) => {
	if (!photoGrid) return;
	if (!items.length) {
		photoGrid.innerHTML = '<p class="empty">还没有摄影作品。</p>';
		return;
	}

	photoGrid.innerHTML = items.map((item) => {
		const filename = escapeHtml(item.filename || '未命名照片');
		const url = escapeHtml(item.url);
		const previewUrl = escapeHtml(item.thumbnailUrl || item.url);
		const date = item.createdAt ? new Date(item.createdAt).toLocaleDateString('zh-CN') : '';
		return `<a class="photo-item" href="${url}" target="_blank" rel="noreferrer">
			<img src="${previewUrl}" alt="${filename}" loading="lazy" decoding="async" />
			<span>${filename}</span>
			${date ? `<time>${escapeHtml(date)}</time>` : ''}
		</a>`;
	}).join('');
};

const loadPhotos = async () => {
	if (!photoGrid) return;
	photoGrid.innerHTML = '<p class="empty">正在加载摄影图库…</p>';
	try {
		const data = await api('/admin-api/media?collection=photos');
		renderPhotos(data.items ?? []);
	} catch (error) {
		photoGrid.innerHTML = `<p class="empty">${escapeHtml(error instanceof Error ? error.message : '摄影图库加载失败')}</p>`;
	}
};

initializeAdminSession({
	loginForm,
	loginStatus,
	logoutButton,
	setAuthenticated: setAuthed,
	onAuthenticated: loadPhotos,
});

refreshPhotosButton?.addEventListener('click', loadPhotos);

photoImageInput?.addEventListener('change', async () => {
	const file = photoImageInput.files?.[0];
	if (!file) return;
	if (photoUploadStatus) photoUploadStatus.textContent = '正在上传照片…';

	try {
		validateImageFile(file);
		const result = await uploadImage(file, 'photos');
		await loadPhotos();
		if (photoUploadStatus) {
			photoUploadStatus.textContent = result.reused
				? '这张照片已经在摄影图库中。'
				: '照片已上传，并会显示在摄影页面。';
		}
	} catch (error) {
		if (photoUploadStatus) photoUploadStatus.textContent = error instanceof Error ? error.message : '上传失败';
	} finally {
		photoImageInput.value = '';
	}
});
