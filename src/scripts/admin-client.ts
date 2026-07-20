export interface AdminSession {
	authenticated: boolean;
	authDisabled?: boolean;
}

interface AdminSessionOptions {
	loginForm: HTMLFormElement | null;
	loginStatus: HTMLElement | null;
	logoutButton: HTMLButtonElement | null;
	setAuthenticated: (authenticated: boolean) => void;
	onAuthenticated: (session: AdminSession) => void | Promise<void>;
}

export const adminApi = async (path: string, options: RequestInit = {}) => {
	const response = await fetch(path, {
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
		...options,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || '请求失败');
	return data;
};

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>((resolve) => {
	canvas.toBlob(resolve, type, quality);
});

const prepareImageUpload = async (file: File, collection: 'blog' | 'photos') => {
	const maxEdge = collection === 'photos' ? 3200 : 2400;
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	try {
		const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		if (scale === 1 && file.size <= 4 * 1024 * 1024) return file;

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) return file;
		context.drawImage(bitmap, 0, 0, width, height);
		const blob = await canvasToBlob(canvas, 'image/webp', collection === 'photos' ? 0.88 : 0.84);
		if (!blob || blob.size >= file.size) return file;
		return new File([blob], file.name.replace(/\.[^.]+$/u, '') + '.webp', {
			type: 'image/webp',
			lastModified: file.lastModified,
		});
	} finally {
		bitmap.close();
	}
};

export const uploadImage = async (
	file: File,
	collection: 'blog' | 'photos' = 'blog',
	onProgress?: (percent: number) => void,
) => {
	const prepared = await prepareImageUpload(file, collection);
	return new Promise<any>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open('POST', '/admin-api/upload');
		request.withCredentials = true;
		request.responseType = 'json';
		request.setRequestHeader('content-type', prepared.type || 'application/octet-stream');
		request.setRequestHeader('x-upload-filename', encodeURIComponent(prepared.name));
		request.setRequestHeader('x-upload-collection', collection);
		request.upload.addEventListener('progress', (event) => {
			if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
		});
		request.addEventListener('load', () => {
			const data = request.response ?? {};
			if (request.status >= 200 && request.status < 300) resolve(data);
			else reject(new Error(data.error || '请求失败'));
		});
		request.addEventListener('error', () => reject(new Error('网络错误，图片上传失败')));
		request.addEventListener('abort', () => reject(new Error('图片上传已取消')));
		request.send(prepared);
	});
};

const supportedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

export const validateImageFile = (file: File) => {
	if (file.size > 45 * 1024 * 1024) {
		throw new Error('图片过大，请上传小于 45 MB 的图片');
	}
	if (!supportedImageTypes.has(file.type)) {
		throw new Error('仅支持 JPEG、PNG、WebP 和 AVIF 图片');
	}
};

export const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	"'": '&#39;',
	'"': '&quot;',
}[character] ?? character));

export const initializeAdminSession = ({
	loginForm,
	loginStatus,
	logoutButton,
	setAuthenticated,
	onAuthenticated,
}: AdminSessionOptions) => {
	adminApi('/admin-api/me')
		.then(async (session: AdminSession) => {
			setAuthenticated(Boolean(session.authenticated));
			if (session.authenticated) await onAuthenticated(session);
		})
		.catch(() => {
			setAuthenticated(false);
			if (loginStatus) loginStatus.textContent = 'Admin API 还没有启动。';
		});

	loginForm?.addEventListener('submit', async (event) => {
		event.preventDefault();
		if (loginStatus) loginStatus.textContent = '正在登录…';
		const form = new FormData(loginForm);

		try {
			await adminApi('/admin-api/login', {
				method: 'POST',
				body: JSON.stringify({
					username: form.get('username'),
					password: form.get('password'),
				}),
			});
			loginForm.reset();
			setAuthenticated(true);
			await onAuthenticated({ authenticated: true });
			if (loginStatus) loginStatus.textContent = '';
		} catch (error) {
			if (loginStatus) loginStatus.textContent = error instanceof Error ? error.message : '登录失败';
		}
	});

	logoutButton?.addEventListener('click', async () => {
		await adminApi('/admin-api/logout', { method: 'POST', body: '{}' }).catch(() => null);
		setAuthenticated(false);
	});
};
