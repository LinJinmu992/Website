import { adminApi as api, fileToBase64, initializeAdminSession, validateImageFile } from './admin-client';

const loginForm = document.querySelector<HTMLFormElement>('[data-login]');
const editorForm = document.querySelector<HTMLFormElement>('[data-editor]');
const postManager = document.querySelector<HTMLElement>('[data-post-manager]');
const postList = document.querySelector<HTMLElement>('[data-post-list]');
const managerStatus = document.querySelector<HTMLElement>('[data-manager-status]');
const refreshPostsButton = document.querySelector<HTMLButtonElement>('[data-refresh-posts]');
const newPostButton = document.querySelector<HTMLButtonElement>('[data-new-post]');
const submitPostButton = document.querySelector<HTMLButtonElement>('[data-submit-post]');
const cancelEditButton = document.querySelector<HTMLButtonElement>('[data-cancel-edit]');
const deletePostButton = document.querySelector<HTMLButtonElement>('[data-delete-post]');
const logoutButton = document.querySelector<HTMLButtonElement>('[data-logout]');
const loginStatus = document.querySelector<HTMLElement>('[data-login-status]');
const editorStatus = document.querySelector<HTMLElement>('[data-editor-status]');
const uploadStatus = document.querySelector<HTMLElement>('[data-upload-status]');
const imageInput = document.querySelector<HTMLInputElement>('[data-image]');
const mediaGrid = document.querySelector<HTMLElement>('[data-media-grid]');
const refreshMediaButton = document.querySelector<HTMLButtonElement>('[data-refresh-media]');
const bodyInput = document.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
const dateInput = document.querySelector<HTMLInputElement>('input[name="date"]');

if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);

const setAuthed = (authed: boolean) => {
	if (loginForm) loginForm.hidden = authed;
	if (postManager) postManager.hidden = !authed;
	if (editorForm) editorForm.hidden = true;
	if (logoutButton) logoutButton.hidden = !authed;
};

const insertAtCursor = (text: string) => {
	if (!bodyInput) return;
	const start = bodyInput.selectionStart;
	const end = bodyInput.selectionEnd;
	const before = bodyInput.value.slice(0, start);
	const after = bodyInput.value.slice(end);
	const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
	const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
	const insert = `${prefix}${text}${suffix}`;
	bodyInput.value = `${before}${insert}${after}`;
	bodyInput.focus();
	bodyInput.setSelectionRange(start + insert.length, start + insert.length);
};

const markdownForImage = (item: { filename?: string; url: string }) => {
	const alt = item.filename?.replace(/\.[^.]+$/, '') || '图片';
	return `![${alt}](${item.url})`;
};

const setEditing = (slug = '') => {
	if (!editorForm) return;
	const originalSlug = editorForm.elements.namedItem('originalSlug') as HTMLInputElement | null;
	if (originalSlug) originalSlug.value = slug;
	if (submitPostButton) submitPostButton.textContent = slug ? '保存修改' : '发布文章';
	if (cancelEditButton) cancelEditButton.hidden = false;
	if (deletePostButton) deletePostButton.hidden = !slug;
};

const showEditor = () => {
	if (postManager) postManager.hidden = true;
	if (editorForm) editorForm.hidden = false;
};

const showPostManager = () => {
	if (postManager) postManager.hidden = false;
	if (editorForm) editorForm.hidden = true;
};

const resetEditor = () => {
	editorForm?.reset();
	if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
	setEditing('');
};

const gitSyncMessage = (gitSync?: { enabled?: boolean; synced?: boolean; changed?: boolean }) => {
	if (!gitSync?.enabled) return '';
	if (gitSync.synced) return gitSync.changed ? '已同步到 GitHub 私有仓库。' : 'GitHub 私有仓库已是最新。';
	return '文章已保存在 VPS，但 GitHub 同步失败；请检查网络后手动同步。';
};

const fillEditor = (post: {
	slug: string;
	title: string;
	date: string;
	description: string;
	readTime: string;
	category: string;
	body: string;
}) => {
	if (!editorForm) return;
	(editorForm.elements.namedItem('title') as HTMLInputElement).value = post.title ?? '';
	(editorForm.elements.namedItem('slug') as HTMLInputElement).value = post.slug ?? '';
	(editorForm.elements.namedItem('category') as HTMLSelectElement).value = post.category ?? '日常';
	(editorForm.elements.namedItem('date') as HTMLInputElement).value = post.date ?? new Date().toISOString().slice(0, 10);
	(editorForm.elements.namedItem('readTime') as HTMLInputElement).value = post.readTime ?? '3 分钟';
	(editorForm.elements.namedItem('description') as HTMLInputElement).value = post.description ?? '';
	(editorForm.elements.namedItem('body') as HTMLTextAreaElement).value = post.body ?? '';
	setEditing(post.slug);
	showEditor();
	editorForm.scrollIntoView({ block: 'start', behavior: 'smooth' });
};

const renderPosts = (posts: Array<{
	slug: string;
	title: string;
	date: string;
	category: string;
	url: string;
}>) => {
	if (!postList) return;
	if (!posts.length) {
		postList.innerHTML = '<p class="empty">还没有文章。</p>';
		return;
	}

	postList.innerHTML = posts.map((post, index) => `
		<article class="post-admin-item">
			<div>
				<h3>${post.title}</h3>
				<div class="post-admin-meta">
					<span>${post.category}</span>
					<time>${post.date}</time>
					<code>${post.slug}</code>
				</div>
			</div>
			<div class="post-admin-actions">
				<a href="${post.url}" target="_blank" rel="noreferrer">查看</a>
				<button class="ghost" type="button" data-edit-post="${index}">编辑</button>
			</div>
		</article>
	`).join('');

	postList.querySelectorAll<HTMLButtonElement>('[data-edit-post]').forEach((button) => {
		button.addEventListener('click', async () => {
			const post = posts[Number(button.dataset.editPost)];
			if (!post || !editorStatus) return;
			editorStatus.textContent = '正在载入文章…';
			try {
				const data = await api(`/admin-api/posts/${encodeURIComponent(post.slug)}`);
				fillEditor(data.post);
				editorStatus.textContent = `正在编辑：${data.post.title}`;
			} catch (error) {
				editorStatus.textContent = error instanceof Error ? error.message : '载入失败';
			}
		});
	});
};

const loadPosts = async () => {
	if (!postList) return;
	postList.innerHTML = '<p class="empty">正在加载文章…</p>';
	try {
		const data = await api('/admin-api/posts');
		renderPosts(data.posts ?? []);
	} catch (error) {
		postList.innerHTML = `<p class="empty">${error instanceof Error ? error.message : '文章加载失败'}</p>`;
	}
};

const renderMedia = (items: Array<{ filename?: string; url: string; createdAt?: string }>) => {
	if (!mediaGrid) return;
	if (!items.length) {
		mediaGrid.innerHTML = '<p class="empty">还没有图片。</p>';
		return;
	}

	mediaGrid.innerHTML = items.map((item, index) => `
		<button class="media-item" type="button" data-media-index="${index}">
			<img src="${item.url}" alt="${item.filename || '图片'}" loading="lazy" />
			<span>${item.filename || '未命名图片'}</span>
		</button>
	`).join('');

	mediaGrid.querySelectorAll<HTMLButtonElement>('[data-media-index]').forEach((button) => {
		button.addEventListener('click', () => {
			const item = items[Number(button.dataset.mediaIndex)];
			if (item) insertAtCursor(markdownForImage(item));
		});
	});
};

const loadMedia = async () => {
	if (!mediaGrid) return;
	mediaGrid.innerHTML = '<p class="empty">正在加载图库…</p>';
	try {
		const data = await api('/admin-api/media?collection=blog');
		renderMedia(data.items ?? []);
	} catch (error) {
		mediaGrid.innerHTML = `<p class="empty">${error instanceof Error ? error.message : '图库加载失败'}</p>`;
	}
};

initializeAdminSession({
	loginForm,
	loginStatus,
	logoutButton,
	setAuthenticated: setAuthed,
	onAuthenticated: async (session) => {
		await Promise.all([loadPosts(), loadMedia()]);
		if (session.authDisabled && editorStatus) {
			editorStatus.textContent = '当前是无密码模式，仅建议在本地或受保护网络中使用。';
		}
	},
});

refreshPostsButton?.addEventListener('click', loadPosts);
newPostButton?.addEventListener('click', () => {
	resetEditor();
	editorStatus && (editorStatus.textContent = '正在新建文章。');
	if (managerStatus) managerStatus.textContent = '';
	showEditor();
	editorForm?.scrollIntoView({ block: 'start', behavior: 'smooth' });
});
cancelEditButton?.addEventListener('click', () => {
	resetEditor();
	editorStatus && (editorStatus.textContent = '');
	showPostManager();
});
deletePostButton?.addEventListener('click', async () => {
	if (!editorForm || !editorStatus) return;
	const originalSlug = (editorForm.elements.namedItem('originalSlug') as HTMLInputElement | null)?.value;
	if (!originalSlug) return;
	const confirmed = window.confirm(`确定删除文章 ${originalSlug} 吗？删除后会移动到 server/trash/posts。`);
	if (!confirmed) return;
	editorStatus.textContent = '正在删除并重新构建…';
	try {
		const result = await api(`/admin-api/posts/${encodeURIComponent(originalSlug)}`, {
			method: 'DELETE',
		});
		resetEditor();
		await loadPosts();
		showPostManager();
		if (managerStatus) managerStatus.textContent = `文章已删除。${gitSyncMessage(result.gitSync)}`;
	} catch (error) {
		editorStatus.textContent = error instanceof Error ? error.message : '删除失败';
	}
});

imageInput?.addEventListener('change', async () => {
	const file = imageInput.files?.[0];
	if (!file || !bodyInput) return;
	if (uploadStatus) uploadStatus.textContent = '正在上传图片…';

	try {
		validateImageFile(file);
		const data = await fileToBase64(file);

		const result = await api('/admin-api/upload', {
			method: 'POST',
			body: JSON.stringify({
				filename: file.name,
				contentType: file.type,
				data,
			}),
		});
		insertAtCursor(markdownForImage(result.item ?? { filename: file.name, url: result.url }));
		await loadMedia();
		if (uploadStatus) uploadStatus.textContent = result.reused ? '这张图已在图库中，已复用并插入正文。' : '图片已上传到图库并插入正文。';
	} catch (error) {
		if (uploadStatus) uploadStatus.textContent = error instanceof Error ? error.message : '上传失败';
	} finally {
		imageInput.value = '';
	}
});

refreshMediaButton?.addEventListener('click', loadMedia);
editorForm?.addEventListener('submit', async (event) => {
	event.preventDefault();
	if (editorStatus) editorStatus.textContent = '正在发布并重新构建…';
	const form = new FormData(editorForm);
	const originalSlug = String(form.get('originalSlug') || '');
	const method = originalSlug ? 'PUT' : 'POST';
	const path = originalSlug ? `/admin-api/posts/${encodeURIComponent(originalSlug)}` : '/admin-api/posts';

	try {
		const result = await api(path, {
			method,
			body: JSON.stringify(Object.fromEntries(form.entries())),
		});
		resetEditor();
		await loadPosts();
		showPostManager();
		if (managerStatus) {
			managerStatus.innerHTML = `${originalSlug ? '修改成功' : '发布成功'}：<a href="${result.url}" target="_blank" rel="noreferrer">${result.url}</a>。${gitSyncMessage(result.gitSync)}如果本地 dev 里 404，请重启 npm run dev。`;
		}
	} catch (error) {
		if (editorStatus) editorStatus.textContent = error instanceof Error ? error.message : '发布失败';
	}
});
