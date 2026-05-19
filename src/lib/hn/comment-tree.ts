/** Build a tree from a flat list of HN comments.
 *  A comment is a child of its `parent` (which may be the story id
 *  itself for top-level comments, or another comment id deeper in).
 *  Orphans (comments whose parent isn't in the set — e.g. on a
 *  partial page) hang off the synthetic root so they still render. */
import type { Comment } from './types';

export interface CommentNode {
	comment: Comment;
	children: CommentNode[];
}

export function buildCommentTree(comments: Comment[], rootId: number): CommentNode[] {
	const byId = new Map<number, CommentNode>();
	for (const c of comments) {
		byId.set(Number(c.key), { comment: c, children: [] });
	}

	const top: CommentNode[] = [];
	for (const node of byId.values()) {
		const parent = node.comment.parent;
		if (parent === rootId) {
			top.push(node);
		} else {
			const parentNode = byId.get(parent);
			if (parentNode) {
				parentNode.children.push(node);
			} else {
				// Orphan — parent not in this page. Treat as top-level
				// for visibility; in a fully-paginated view this would
				// link to "show context".
				top.push(node);
			}
		}
	}

	// Sort each level by time ascending — HN's chronological view.
	const sortByTime = (a: CommentNode, b: CommentNode) => a.comment.time - b.comment.time;
	top.sort(sortByTime);
	for (const node of byId.values()) {
		node.children.sort(sortByTime);
	}

	return top;
}

export function countNodes(tree: CommentNode[]): number {
	let n = 0;
	const walk = (nodes: CommentNode[]) => {
		for (const node of nodes) {
			n++;
			walk(node.children);
		}
	};
	walk(tree);
	return n;
}
