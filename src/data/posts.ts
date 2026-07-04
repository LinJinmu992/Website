import type { MarkdownInstance } from 'astro';

export interface PostFrontmatter {
	title: string;
	date: string;
	description: string;
	readTime: string;
	category: '日常' | '笔记';
}

const modules = import.meta.glob<MarkdownInstance<PostFrontmatter>>(
	'../content/posts/*.md',
	{ eager: true },
);

export const posts = Object.entries(modules)
	.map(([path, markdown]) => {
		const slug = path.split('/').at(-1)?.replace(/\.md$/, '') ?? '';
		const { title, date, description, readTime, category } = markdown.frontmatter;

		return {
			slug,
			title,
			date,
			displayDate: date.slice(5).replace('-', ' · '),
			description,
			readTime,
			category,
			Content: markdown.Content,
		};
	})
	.sort((a, b) => b.date.localeCompare(a.date));
