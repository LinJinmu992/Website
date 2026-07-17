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

export const fileToBase64 = (file: File) => new Promise<string>((resolve, reject) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(file);
});

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
