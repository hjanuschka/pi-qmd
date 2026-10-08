/**
 * QMD Extension - Quick Markdown Search for Knowledge Management
 *
 * Integrates tobi/qmd (https://github.com/tobi/qmd) with pi for seamless
 * knowledge retrieval. QMD is an on-device search engine that combines
 * BM25 full-text search, vector semantic search, and LLM re-ranking.
 *
 * Tools:
 *   qmd_search    - Fast BM25 keyword search
 *   qmd_vsearch   - Semantic vector search
 *   qmd_query     - Hybrid search with reranking (best quality)
 *   qmd_get       - Retrieve document by path or docid
 *   qmd_multi_get - Retrieve multiple documents by glob/list
 *   qmd_status    - Index health and collection info
 *
 * Commands:
 *   /qmd [query]        - Quick search your knowledge base
 *   /qmd status         - Show collection status
 *   /qmd collections    - List all collections
 *   /qmd add <path>     - Add a new collection
 *   /qmd embed          - Generate/update embeddings
 *   /qmd_ui [query]     - Open full TUI browser
 *
 * TUI Browser Features (/qmd_ui):
 *   - Interactive search with real-time results
 *   - Toggle between Hybrid/Keyword/Semantic search (Tab)
 *   - Filter by collection (Ctrl+C)
 *   - Preview documents before loading
 *   - Search history (↑/↓ in search mode)
 *   - Load documents directly into conversation context
 *
 * Example usage:
 *   /qmd how to deploy   - Quick search for deployment docs
 *   /qmd_ui              - Open knowledge browser
 *   /qmd_ui auth flow    - Open browser with initial search
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getMarkdownTheme, DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	Input,
	Key,
	Markdown,
	Spacer,
	Text,
	TUI,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ============================================================================
// Types
// ============================================================================

interface QmdResult {
	path: string;
	docid: string;
	title?: string;
	context?: string;
	score: number;
	snippet?: string;
	line?: number;
}

interface QmdCollection {
	name: string;
	path: string;
	fileCount?: number;
}

interface QmdStatus {
	collections: QmdCollection[];
	totalDocs: number;
	hasEmbeddings: boolean;
	indexPath?: string;
	indexSize?: string;
	updated?: string;
	vectorCount?: number;
}

// ============================================================================
// ANSI Helpers
// ============================================================================

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;


async function execQmdDirect(
	qmdPath: string,
	args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
	
	try {
		const { stdout, stderr } = await execFileAsync(qmdPath, args, {
			timeout: 15000,
			maxBuffer: 10 * 1024 * 1024,
		});
		return { stdout, stderr, code: 0 };
	} catch (e: any) {
		
		return {
			stdout: e?.stdout || "",
			stderr: e?.stderr || e?.message || "Unknown error",
			code: e?.code || 1,
		};
	}
}

// ============================================================================
// QMD Command Execution
// ============================================================================

async function execQmd(
	pi: ExtensionAPI,
	args: string[],
	signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; code: number }> {
	const path = await findQmdPath(pi);
	if (!path) {
		return {
			stdout: "",
			stderr: "QMD not found. Install with: " + QMD_INSTALL_CMD,
			code: 127,
		};
	}
	const result = await pi.exec(path, args, { signal, timeout: 60000 });
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code ?? 0,
	};
}

// QMD requires Bun runtime - see https://github.com/tobi/qmd
const QMD_INSTALL_CMD = "brew install oven-sh/bun/bun && bun install -g https://github.com/tobi/qmd";

function messageText(content: string | { type: string }[] | undefined): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	return content
		.map((c) => (c.type === "text" ? (c as { type: string; text: string }).text : ""))
		.join("");
}

// Common locations for qmd binary
const QMD_PATHS = [
	`${process.env.HOME}/.bun/bin/qmd`, // Bun global install (most likely)
	"qmd", // In PATH
	"/opt/homebrew/bin/qmd", // Homebrew
	"/usr/local/bin/qmd", // Standard location
];

let qmdPath: string | null = null;

async function findQmdPath(pi: ExtensionAPI): Promise<string | null> {
	if (qmdPath) return qmdPath;
	
	for (const path of QMD_PATHS) {
		try {
			const result = await pi.exec(path, ["--help"], { timeout: 5000 });
			if (result.code === 0) {
				qmdPath = path;
				return path;
			}
		} catch {
			// Try next path
		}
	}
	return null;
}

async function checkQmdInstalled(pi: ExtensionAPI): Promise<boolean> {
	const path = await findQmdPath(pi);
	return path !== null;
}


// ============================================================================
// Result Parsing
// ============================================================================

function parseJsonResults(stdout: string): QmdResult[] {
	try {
		const data = JSON.parse(stdout);
		if (Array.isArray(data)) {
			return data.map((item: any) => ({
				path: item.path || item.file || "",
				docid: item.docid || item.id || "",
				title: item.title,
				context: item.context,
				score: item.score || 0,
				snippet: item.snippet || item.content,
				line: item.line,
			}));
		}
		return [];
	} catch {
		return [];
	}
}

function parseStatusOutput(stdout: string): QmdStatus | null {
	try {
		const data = JSON.parse(stdout);
		return {
			collections: (data.collections || []).map((c: any) => ({
				name: c.name,
				path: c.path,
				fileCount: c.fileCount || c.files,
			})),
			totalDocs: data.totalDocs || data.documents || 0,
			hasEmbeddings: data.hasEmbeddings ?? data.embedded ?? false,
		};
	} catch {
		// Parse text output (qmd status --json currently prints text)
		const collections: QmdCollection[] = [];
		const lines = stdout.split("\n");
		let current: QmdCollection | null = null;
		let totalDocs = 0;
		let vectors = 0;
		let indexPath: string | undefined;
		let indexSize: string | undefined;
		let updated: string | undefined;

		for (const line of lines) {
			const indexMatch = line.match(/^\s*Index:\s*(.+)$/i);
			if (indexMatch) {
				indexPath = indexMatch[1].trim();
				continue;
			}

			const sizeMatch = line.match(/^\s*Size:\s*(.+)$/i);
			if (sizeMatch) {
				indexSize = sizeMatch[1].trim();
				continue;
			}

			const totalMatch = line.match(/^\s*Total:\s*(\d+)/i);
			if (totalMatch) {
				totalDocs = parseInt(totalMatch[1], 10);
				continue;
			}

			const vectorMatch = line.match(/^\s*Vectors?:\s*(\d+)/i);
			if (vectorMatch) {
				vectors = parseInt(vectorMatch[1], 10);
				continue;
			}

			const updatedMatch = line.match(/^\s*Updated:\s*(.+)$/i);
			if (updatedMatch) {
				updated = updatedMatch[1].trim();
				continue;
			}

			const collectionMatch = line.match(/^\s{2,}([^\s]+)\s+\((qmd:\/\/[^)]+)\)/);
			if (collectionMatch) {
				current = {
					name: collectionMatch[1],
					path: collectionMatch[2],
				};
				collections.push(current);
				continue;
			}

			const filesMatch = line.match(/^\s*Files:\s*(\d+)/i);
			if (filesMatch && current) {
				current.fileCount = parseInt(filesMatch[1], 10);
				continue;
			}
		}

		if (collections.length === 0 && totalDocs === 0 && !indexPath) {
			return null;
		}

		if (totalDocs === 0) {
			totalDocs = collections.reduce((sum, c) => sum + (c.fileCount || 0), 0);
		}

		return {
			collections,
			totalDocs,
			hasEmbeddings: vectors > 0 || stdout.includes("embeddings") || stdout.includes("embedded"),
			indexPath,
			indexSize,
			updated,
			vectorCount: vectors || undefined,
		};
	}
}

// ============================================================================
// Result Formatting
// ============================================================================

function formatResultsForLLM(results: QmdResult[], query: string): string {
	if (results.length === 0) {
		return `No results found for: "${query}"`;
	}

	const lines: string[] = [
		`Found ${results.length} results for: "${query}"`,
		"",
	];

	for (const r of results) {
		const scorePercent = Math.round(r.score * 100);
		lines.push(`## ${r.title || r.path} (${scorePercent}%)`);
		lines.push(`- Path: ${r.path}`);
		lines.push(`- DocID: #${r.docid}`);
		if (r.context) lines.push(`- Context: ${r.context}`);
		if (r.line) lines.push(`- Line: ${r.line}`);
		if (r.snippet) {
			lines.push("");
			lines.push("```");
			lines.push(r.snippet.trim());
			lines.push("```");
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// TUI Browser
// ============================================================================

type SearchType = "query" | "search" | "vsearch";

type QmdBrowserResult = { action: "load"; doc: QmdResult } | null;

class QmdBrowserComponent extends Container implements Focusable {
	private searchInput: Input;
	private listContainer: Container;
	private headerLine = "";
	private hintLine = "";
	private statusLine = "";
	private results: QmdResult[] = [];
	private selectedIndex = 0;
	private loading = false;
	private error: string | null = null;
	private searchType: SearchType = "search";
	private focusMode: "input" | "results" = "input";
	private previewLines: string[] = [];
	private previewOffset = 0;
	private previewDoc: QmdResult | null = null;
	private previewContent = "";
	private previewPageSize = 10;
	private previewLoading = false;
	private previewRequestId = 0;
	private previewRenderWidth = 0;
	private previewHighlightStart = -1;
	private previewHighlightEnd = -1;
	private fixedCols: number;
	private fixedRows: number;
	private boxWidth: number;
	private innerWidth: number;
	private targetHeight: number;
	private tui: TUI;
	private theme: Theme;
	private exec: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
	private onDone: (result: QmdBrowserResult) => void;

	private _focused = false;
	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		tui: TUI,
		theme: Theme,
		exec: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>,
		onDone: (result: QmdBrowserResult) => void,
		initialQuery?: string
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.exec = exec;
		this.onDone = onDone;

		this.fixedCols = typeof process !== "undefined" && process.stdout?.columns ? process.stdout.columns : 120;
		this.fixedRows = typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : 40;
		this.boxWidth = Math.max(60, Math.floor(this.fixedCols * 0.7));
		this.innerWidth = this.boxWidth - 4;
		this.targetHeight = Math.max(16, Math.floor(this.fixedRows * 0.7));

		this.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialQuery) this.searchInput.setValue(initialQuery);
		this.searchInput.onSubmit = () => {
			void this.runSearch();
		};

		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.updateHeader();
		this.updateHints();
		this.updateStatus("Type a query and press Enter");
		this.updateList();

		if (initialQuery) {
			setTimeout(() => {
				void this.runSearch();
			}, 0);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		
		if (kb.matches(keyData, "tui.select.cancel") || matchesKey(keyData, Key.escape)) {
			this.onDone(null);
			return;
		}

		if (matchesKey(keyData, Key.tab)) {
			this.cycleSearchType();
			return;
		}

		const pageSize = this.getPreviewPageSize();
		if (this.isPageUp(keyData)) {
			this.previewOffset = Math.max(0, this.previewOffset - pageSize);
			this.updateList();
			return;
		}
		if (this.isPageDown(keyData)) {
			this.previewOffset = Math.min(Math.max(0, this.previewLines.length - 1), this.previewOffset + pageSize);
			this.updateList();
			return;
		}

		if (this.focusMode === "results") {
			if (kb.matches(keyData, "tui.select.up")) {
				if (this.results.length === 0) return;
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				const selected = this.results[this.selectedIndex];
				if (selected) void this.loadPreview(selected);
				this.updateList();
				return;
			}

			if (kb.matches(keyData, "tui.select.down")) {
				if (this.results.length === 0) return;
				this.selectedIndex = Math.min(this.results.length - 1, this.selectedIndex + 1);
				const selected = this.results[this.selectedIndex];
				if (selected) void this.loadPreview(selected);
				this.updateList();
				return;
			}

			if (kb.matches(keyData, "tui.select.confirm")) {
				const selected = this.results[this.selectedIndex];
				if (selected) this.onDone({ action: "load", doc: selected });
				return;
			}
		}

		if (kb.matches(keyData, "tui.select.up") || kb.matches(keyData, "tui.select.down")) {
			if (this.results.length > 0) {
				this.focusMode = "results";
				this.updateList();
				return;
			}
		}

		this.focusMode = "input";
		this.searchInput.handleInput(keyData);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateHeader();
		this.updateHints();
		this.updateList();
	}

	render(width: number): string[] {
		const boxWidth = this.boxWidth;
		const innerWidth = this.innerWidth;
		const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
		const padLeft = " ".repeat(leftPad);
		const border = (char: string) => char.repeat(boxWidth - 2);
		const top = this.theme.fg("accent", `╭${border("─")}╮`);
		const mid = this.theme.fg("accent", `├${border("─")}┤`);
		const bottom = this.theme.fg("accent", `╰${border("─")}╯`);
		const boxLine = (content: string) => {
			const padded = truncateToWidth(content, innerWidth, "");
			const pad = Math.max(0, innerWidth - visibleWidth(padded));
			return padLeft + this.theme.fg("accent", "│ ") + padded + " ".repeat(pad) + this.theme.fg("accent", " │");
		};

		const inputLines = this.searchInput.render(innerWidth);
		const inputLine = inputLines[0] || "";
		const fixedLines = 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 1; // top/header/mid/search/input/status/mid/list/mid/hint/bottom
		const listHeight = Math.max(4, this.targetHeight - fixedLines);
		this.previewPageSize = Math.max(4, listHeight - 2);
		

		const lines: string[] = [];
		lines.push(padLeft + top);
		lines.push(boxLine(this.headerLine));
		lines.push(padLeft + mid);
		lines.push(boxLine(this.theme.fg("muted", "Search:")));
		lines.push(boxLine(inputLine));
		lines.push(boxLine(this.statusLine));
		lines.push(padLeft + mid);
		const listLines = this.buildListLines(innerWidth, listHeight);
		for (const line of listLines) {
			lines.push(boxLine(line));
		}
		lines.push(padLeft + mid);
		lines.push(boxLine(this.hintLine));
		lines.push(padLeft + bottom);

		return lines;
	}

	private updateHeader(): void {
		const label = this.searchType === "query" ? "Hybrid" : this.searchType === "search" ? "Keyword" : "Semantic";
		const title = `📚 QMD Browser (${label})`;
		this.headerLine = this.theme.fg("accent", this.theme.bold(title));
	}

	private updateHints(): void {
		const text = "Enter search • Tab mode • ↑↓ navigate • Enter load • PgUp/PgDn preview • Esc close";
		this.hintLine = this.theme.fg("dim", text);
	}

	private updateStatus(text: string): void {
		this.statusLine = this.theme.fg("muted", text);
	}

	private cycleSearchType(): void {
		this.searchType = this.searchType === "query" ? "search" : this.searchType === "search" ? "vsearch" : "query";
		this.updateHeader();
		this.tui.requestRender();
		if (this.searchInput.getValue().trim()) {
			void this.runSearch();
		}
	}

	private async runSearch(): Promise<void> {
		const query = this.searchInput.getValue().trim();
		if (!query) return;

		
		this.loading = true;
		this.error = null;
		this.updateStatus(`Searching (${this.searchType})...`);
		this.updateList();
		this.tui.requestRender();

		const args = [this.searchType, query, "--json", "-n", "20"];
		const result = await this.exec(args);
		

		if (result.code !== 0) {
			this.error = result.stderr || "Search failed";
			this.results = [];
			this.loading = false;
			this.updateStatus(this.error);
			this.updateList();
			this.tui.requestRender();
			return;
		}

		this.results = parseJsonResults(result.stdout);
		
		this.selectedIndex = 0;
		this.loading = false;
		this.error = null;
		this.focusMode = this.results.length > 0 ? "results" : "input";
		this.updateHints();
		this.updateStatus(this.results.length ? `Found ${this.results.length} results` : "No results found");
		this.updateList();
		this.tui.requestRender();

		if (this.results.length > 0) {
			void this.loadPreview(this.results[0]);
		}
	}

	private updateList(): void {
		this.tui.requestRender();
	}

	private buildListLines(innerWidth: number, maxLines: number): string[] {
		const leftWidth = Math.max(20, Math.floor(innerWidth * 0.45));
		const rightWidth = Math.max(20, innerWidth - leftWidth - 3);
		if (this.previewContent && rightWidth !== this.previewRenderWidth) {
			this.previewLines = this.renderMarkdownPreview(rightWidth);
			this.previewRenderWidth = rightWidth;
		}
		const pad = (text: string, width: number) => {
			const truncated = truncateToWidth(text, width, "");
			const padLen = Math.max(0, width - visibleWidth(truncated));
			return truncated + " ".repeat(padLen);
		};

		if (this.loading) return [this.theme.fg("muted", "Searching...")];
		if (this.error) return [this.theme.fg("error", this.error)];

		const leftLines: string[] = [this.theme.fg("muted", "Results")];
		const rightLines: string[] = [this.theme.fg("muted", "Preview")];

		if (this.results.length === 0) {
			leftLines.push(this.theme.fg("muted", "No results"));
		} else {
			// Group results by context/category
			const groups = new Map<string, { results: QmdResult[]; indices: number[] }>();
			for (let i = 0; i < this.results.length; i++) {
				const r = this.results[i];
				const ctx = r.context || "Other";
				if (!groups.has(ctx)) {
					groups.set(ctx, { results: [], indices: [] });
				}
				groups.get(ctx)!.results.push(r);
				groups.get(ctx)!.indices.push(i);
			}

			// Build tree view
			let lineCount = 0;
			const maxVisible = maxLines - 2;
			
			for (const [ctx, group] of groups) {
				if (lineCount >= maxVisible) break;
				
				// Category header
				leftLines.push(this.theme.fg("accent", `📁 ${ctx}`));
				lineCount++;
				
				// Items in category
				for (let j = 0; j < group.results.length; j++) {
					if (lineCount >= maxVisible) break;
					
					const r = group.results[j];
					const globalIndex = group.indices[j];
					const isSelected = globalIndex === this.selectedIndex;
					const isLast = j === group.results.length - 1;
					const branch = isLast ? "└─ " : "├─ ";
					const prefix = isSelected ? this.theme.fg("accent", branch.replace("─", "→")) : this.theme.fg("muted", branch);
					const title = r.title || r.path.split("/").pop() || r.path;
					const score = Math.round(r.score * 100);
					const scoreText = this.theme.fg(score >= 70 ? "success" : score >= 40 ? "warning" : "muted", `${score}%`);
					const titleStyled = isSelected ? this.theme.fg("accent", title) : title;
					leftLines.push(`${prefix}${titleStyled} ${scoreText}`);
					lineCount++;
				}
			}
		}

		if (this.previewLoading) {
			rightLines.push(this.theme.fg("muted", "Loading preview..."));
		} else if (this.previewLines.length > 0) {
			const maxVisible = this.getPreviewPageSize();
			const start = Math.max(0, Math.min(this.previewOffset, Math.max(0, this.previewLines.length - maxVisible)));
			const end = Math.min(start + maxVisible, this.previewLines.length);
			for (let i = start; i < end; i++) {
				let line = this.previewLines[i] || "";
				// Highlight matched section
				if (i >= this.previewHighlightStart && i < this.previewHighlightEnd) {
					line = this.theme.bg("selectedBg", line);
				}
				rightLines.push(line);
			}
			if (this.previewLines.length > maxVisible) {
				rightLines.push(this.theme.fg("dim", `(${start + 1}-${end}/${this.previewLines.length})`));
			}
		} else {
			rightLines.push(this.theme.fg("muted", "Select a result to preview"));
		}

		const maxMerged = Math.max(leftLines.length, rightLines.length);
		const merged: string[] = [];
		for (let i = 0; i < maxMerged; i++) {
			const left = pad(leftLines[i] || "", leftWidth);
			const right = pad(rightLines[i] || "", rightWidth);
			merged.push(`${left} │ ${right}`);
		}

		if (merged.length > maxLines) return merged.slice(0, maxLines);
		while (merged.length < maxLines) merged.push("");
		return merged;
	}

	private getPreviewPageSize(): number {
		return Math.max(6, this.previewPageSize);
	}

	private isPageUp(keyData: string): boolean {
		return matchesKey(keyData, "pageUp") || keyData === "\u001b[5~" || keyData === "\u001b[5;5~";
	}

	private isPageDown(keyData: string): boolean {
		return matchesKey(keyData, "pageDown") || keyData === "\u001b[6~" || keyData === "\u001b[6;5~";
	}

	private renderMarkdownPreview(width: number): string[] {
		const mdTheme = getMarkdownTheme();
		const md = new Markdown(this.previewContent, 0, 0, mdTheme);
		return md.render(width);
	}

	private findPreviewOffset(doc: QmdResult): number {
		this.previewHighlightStart = -1;
		this.previewHighlightEnd = -1;
		
		if (!doc.snippet) return 0;
		
		// Extract clean text from snippet (skip diff markers like @@ -15,4 @@)
		const snippetLines = doc.snippet.split("\n")
			.filter(l => !l.startsWith("@@") && !l.startsWith("---") && !l.startsWith("+++"))
			.map(l => l.replace(/^[+-]\s*/, "").trim().toLowerCase())
			.filter(l => l.length > 10);
		
		if (snippetLines.length === 0) return 0;
		
		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		
		// Find best match and set highlight range
		for (const target of snippetLines) {
			for (let i = 0; i < this.previewLines.length; i++) {
				const line = stripAnsi(this.previewLines[i] || "").toLowerCase();
				if (line.includes(target.slice(0, 30))) {
					this.previewHighlightStart = i;
					this.previewHighlightEnd = Math.min(i + snippetLines.length + 2, this.previewLines.length);
					return Math.max(0, i - 2);
				}
			}
		}
		
		// Fallback: try matching title
		if (doc.title) {
			const titleLower = doc.title.toLowerCase();
			for (let i = 0; i < this.previewLines.length; i++) {
				const line = stripAnsi(this.previewLines[i] || "").toLowerCase();
				if (line.includes(titleLower)) {
					this.previewHighlightStart = i;
					this.previewHighlightEnd = i + 1;
					return Math.max(0, i - 1);
				}
			}
		}
		
		return 0;
	}

	private async loadPreview(doc: QmdResult): Promise<void> {
		this.previewRequestId += 1;
		const requestId = this.previewRequestId;
		this.previewLoading = true;
		this.previewDoc = doc;
		this.previewLines = [];
		this.previewContent = "";
		this.previewOffset = 0;
		this.updateStatus("Loading preview...");
		this.updateList();
		this.tui.requestRender();

		const result = await this.exec(["get", doc.path, "--full"]);
		if (requestId !== this.previewRequestId) return;
		if (result.code !== 0) {
			this.previewLoading = false;
			this.error = result.stderr || "Failed to load preview";
			this.updateStatus(this.error);
			this.updateList();
			this.tui.requestRender();
			return;
		}

		this.previewContent = result.stdout;
		const initialWidth = Math.max(20, Math.floor((this.tui.terminal.columns * 0.7 - 8) * 0.55));
		this.previewLines = this.renderMarkdownPreview(initialWidth);
		this.previewRenderWidth = initialWidth;
		this.previewLoading = false;
		this.error = null;
		this.previewOffset = this.findPreviewOffset(doc);
		this.updateStatus(`Previewing ${doc.title || doc.path}`);
		this.updateList();
		this.tui.requestRender();
	}
}


// ============================================================================
// Extension
// ============================================================================

export default function qmdExtension(pi: ExtensionAPI): void {
	// ========================================================================
	// Tools
	// ========================================================================

	// qmd_search - Fast BM25 keyword search
	pi.registerTool({
		name: "qmd_search",
		label: "QMD Search",
		description: `Fast BM25 full-text keyword search across your knowledge base.
Use this for exact keyword matches and known terms.
Returns: path, docid, title, score, snippet.
Use qmd_get with the docid or path to retrieve full content.`,
		parameters: Type.Object({
			query: Type.String({ description: "Search query (keywords)" }),
			collection: Type.Optional(Type.String({ description: "Restrict to specific collection" })),
			count: Type.Optional(Type.Number({ description: "Number of results (default: 10)" })),
			minScore: Type.Optional(Type.Number({ description: "Minimum score threshold 0-1 (default: 0)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const args = ["search", params.query, "--json"];
			if (params.collection) args.push("-c", params.collection);
			args.push("-n", String(params.count || 10));
			if (params.minScore) args.push("--min-score", String(params.minScore));

			const result = await execQmd(pi, args, signal);
			
			if (result.code !== 0) {
				return {
					content: [{ type: "text", text: `QMD search failed: ${result.stderr || "Unknown error"}` }],
					isError: true,
					details: undefined,
				};
			}

			const results = parseJsonResults(result.stdout);
			const formatted = formatResultsForLLM(results, params.query);
			
			const truncated = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			return {
				content: [{ type: "text", text: truncated.content }],
				details: { 
					resultCount: results.length,
					truncated: truncated.truncated,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("qmd_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.collection) text += theme.fg("muted", ` in ${args.collection}`);
			return new Text(text, 0, 0);
		},
	});

	// qmd_vsearch - Semantic vector search
	pi.registerTool({
		name: "qmd_vsearch",
		label: "QMD Vector Search",
		description: `Semantic vector search using embeddings.
Use this when the user's query is conceptual or uses different words than the docs.
Requires embeddings (run 'qmd embed' first).
Returns: path, docid, title, score, snippet.`,
		parameters: Type.Object({
			query: Type.String({ description: "Search query (natural language)" }),
			collection: Type.Optional(Type.String({ description: "Restrict to specific collection" })),
			count: Type.Optional(Type.Number({ description: "Number of results (default: 10)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const args = ["vsearch", params.query, "--json"];
			if (params.collection) args.push("-c", params.collection);
			args.push("-n", String(params.count || 10));

			const result = await execQmd(pi, args, signal);
			
			if (result.code !== 0) {
				return {
					content: [{ type: "text", text: `QMD vsearch failed: ${result.stderr || "Unknown error"}` }],
					isError: true,
					details: undefined,
				};
			}

			const results = parseJsonResults(result.stdout);
			const formatted = formatResultsForLLM(results, params.query);
			
			const truncated = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			return {
				content: [{ type: "text", text: truncated.content }],
				details: { resultCount: results.length, truncated: truncated.truncated },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("qmd_vsearch "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.collection) text += theme.fg("muted", ` in ${args.collection}`);
			return new Text(text, 0, 0);
		},
	});

	// qmd_query - Hybrid search with reranking (best quality)
	pi.registerTool({
		name: "qmd_query",
		label: "QMD Query",
		description: `Hybrid search combining BM25, vector search, query expansion, and LLM reranking.
This is the highest quality search - use it when you need the best results.
Slower than search/vsearch but more accurate.
Returns: path, docid, title, score, snippet.`,
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			collection: Type.Optional(Type.String({ description: "Restrict to specific collection" })),
			count: Type.Optional(Type.Number({ description: "Number of results (default: 10)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Running hybrid search with reranking..." }], details: undefined });

			const args = ["query", params.query, "--json"];
			if (params.collection) args.push("-c", params.collection);
			args.push("-n", String(params.count || 10));

			const result = await execQmd(pi, args, signal);
			
			if (result.code !== 0) {
				return {
					content: [{ type: "text", text: `QMD query failed: ${result.stderr || "Unknown error"}` }],
					isError: true,
					details: undefined,
				};
			}

			const results = parseJsonResults(result.stdout);
			const formatted = formatResultsForLLM(results, params.query);
			
			const truncated = truncateHead(formatted, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			return {
				content: [{ type: "text", text: truncated.content }],
				details: { resultCount: results.length, truncated: truncated.truncated },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("qmd_query "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.collection) text += theme.fg("muted", ` in ${args.collection}`);
			return new Text(text, 0, 0);
		},
	});

	// qmd_get - Retrieve document content
	pi.registerTool({
		name: "qmd_get",
		label: "QMD Get",
		description: `Retrieve a document by path or docid.
Use paths from search results (e.g., "notes/meeting.md") or docids (e.g., "#abc123").
Supports fuzzy matching - if exact path not found, suggests alternatives.`,
		parameters: Type.Object({
			path: Type.String({ description: "Document path or docid (e.g., 'docs/api.md' or '#abc123')" }),
			full: Type.Optional(Type.Boolean({ description: "Return full content (default: true)" })),
			fromLine: Type.Optional(Type.Number({ description: "Start from line number" })),
			maxLines: Type.Optional(Type.Number({ description: "Maximum lines to return" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const args = ["get", params.path];
			if (params.full !== false) args.push("--full");
			if (params.fromLine) args.push("--from", String(params.fromLine));
			if (params.maxLines) args.push("-l", String(params.maxLines));

			const result = await execQmd(pi, args, signal);
			
			if (result.code !== 0) {
				return {
					content: [{ type: "text", text: `QMD get failed: ${result.stderr || "Unknown error"}` }],
					isError: true,
					details: undefined,
				};
			}

			const truncated = truncateHead(result.stdout, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let content = truncated.content;
			if (truncated.truncated) {
				content += `\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines]`;
			}

			return {
				content: [{ type: "text", text: content }],
				details: { path: params.path, truncated: truncated.truncated },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("qmd_get "));
			text += theme.fg("accent", args.path);
			return new Text(text, 0, 0);
		},
	});

	// qmd_multi_get - Retrieve multiple documents
	pi.registerTool({
		name: "qmd_multi_get",
		label: "QMD Multi Get",
		description: `Retrieve multiple documents by glob pattern, list, or docids.
Examples: "docs/*.md", "doc1.md, doc2.md", "#abc123, #def456"`,
		parameters: Type.Object({
			pattern: Type.String({ description: "Glob pattern, comma-separated paths, or docids" }),
			maxBytes: Type.Optional(Type.Number({ description: "Skip files larger than N bytes (default: 10KB)" })),
			maxLines: Type.Optional(Type.Number({ description: "Maximum lines per file" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const args = ["multi-get", params.pattern];
			if (params.maxBytes) args.push("--max-bytes", String(params.maxBytes));
			if (params.maxLines) args.push("-l", String(params.maxLines));

			const result = await execQmd(pi, args, signal);
			
			if (result.code !== 0) {
				return {
					content: [{ type: "text", text: `QMD multi-get failed: ${result.stderr || "Unknown error"}` }],
					isError: true,
					details: undefined,
				};
			}

			const truncated = truncateHead(result.stdout, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			let content = truncated.content;
			if (truncated.truncated) {
				content += `\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines]`;
			}

			return {
				content: [{ type: "text", text: content }],
				details: { pattern: params.pattern, truncated: truncated.truncated },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("qmd_multi_get "));
			text += theme.fg("accent", args.pattern);
			return new Text(text, 0, 0);
		},
	});

	// qmd_status - Index health and collection info
	pi.registerTool({
		name: "qmd_status",
		label: "QMD Status",
		description: `Check QMD index health and list collections.
Shows: total documents, embedding status, collection names and paths.`,
		parameters: Type.Object({}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await execQmd(pi, ["status", "--json"], signal);
			
			if (result.code !== 0) {
				// Try without --json for older versions
				const fallback = await execQmd(pi, ["status"], signal);
				if (fallback.code !== 0) {
					return {
						content: [{ type: "text", text: `QMD status failed: ${fallback.stderr || "Unknown error"}` }],
						isError: true,
						details: undefined,
					};
				}
				return {
					content: [{ type: "text", text: fallback.stdout }],
					details: {},
				};
			}

			const status = parseStatusOutput(result.stdout);
			if (!status) {
				return {
					content: [{ type: "text", text: result.stdout }],
					details: {},
				};
			}

			const lines: string[] = [
				"# QMD Status",
				"",
				`**Total Documents:** ${status.totalDocs}`,
				`**Embeddings:** ${status.hasEmbeddings ? "Ready ✓" : "Not generated (run 'qmd embed')"}`,
				"",
				"## Collections",
				"",
			];

			for (const c of status.collections) {
				lines.push(`- **${c.name}** (${c.fileCount || "?"} files)`);
				lines.push(`  - Path: ${c.path}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: status,
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("qmd_status")), 0, 0);
		},
	});

	// ========================================================================
	// Commands
	// ========================================================================

	pi.registerCommand("qmd", {
		description: "Search your knowledge base with QMD",
		handler: async (args, ctx) => {
			// Check if qmd is installed
			const installed = await checkQmdInstalled(pi);
			if (!installed) {
				ctx.ui.notify("QMD not found. Install: brew install oven-sh/bun/bun && bun i -g https://github.com/tobi/qmd", "error");
				return;
			}

			const trimmedArgs = args?.trim() || "";

			// Handle subcommands
			if (trimmedArgs === "status" || trimmedArgs === "") {
				const statusResult = await execQmd(pi, ["status", "--json"]);
				if (statusResult.code !== 0) {
					ctx.ui.notify(statusResult.stderr || "Failed to get status", "error");
					return;
				}
				const status = parseStatusOutput(statusResult.stdout);
				if (!status) {
					// Fallback: show raw output
					const raw = statusResult.stdout || "(empty status output)";
					pi.sendMessage({
						customType: "qmd-info",
						content: `## 📚 QMD Status\n\n\`\`\`\n${raw}\n\`\`\``,
						display: true,
					});
					return;
				}
				
				// Format status as markdown message
				const lines = [
					`## 📚 QMD Status`,
					``,
				];
				if (status.indexPath) lines.push(`**Index:** ${status.indexPath}`);
				if (status.indexSize) lines.push(`**Size:** ${status.indexSize}`);
				lines.push(`**Documents:** ${status.totalDocs}`);
				if (status.vectorCount !== undefined) {
					lines.push(`**Vectors:** ${status.vectorCount}`);
				}
				if (status.updated) {
					lines.push(`**Updated:** ${status.updated}`);
				}
				lines.push(`**Embeddings:** ${status.hasEmbeddings ? "✓ Yes" : "✗ No"}`);
				lines.push("", `### Collections (${status.collections.length})`, "");
				for (const c of status.collections) {
					const count = c.fileCount ?? "?";
					lines.push(`- **${c.name}** (${count} files) - ${c.path}`);
				}
				
				pi.sendMessage({
					customType: "qmd-info",
					content: lines.join("\n"),
					display: true,
				});
				return;
			}

			if (trimmedArgs === "collections") {
				const result = await execQmd(pi, ["collection", "list"]);
				ctx.ui.notify(result.stdout || result.stderr, result.code === 0 ? "info" : "error");
				return;
			}

			if (trimmedArgs.startsWith("add ")) {
				const path = trimmedArgs.slice(4).trim();
				if (!path) {
					ctx.ui.notify("Usage: /qmd add <path> [--name <name>]", "warning");
					return;
				}
				
				// Parse path and optional name
				const parts = path.split(/\s+--name\s+/);
				const collPath = parts[0];
				const name = parts[1] || collPath.split("/").pop() || "collection";
				
				const result = await execQmd(pi, ["collection", "add", collPath, "--name", name]);
				if (result.code === 0) {
					ctx.ui.notify(`Added collection: ${name}`, "info");
				} else {
					ctx.ui.notify(result.stderr || "Failed to add collection", "error");
				}
				return;
			}

			if (trimmedArgs === "embed") {
				ctx.ui.notify("Running embeddings... this may take a while", "info");
				const result = await execQmd(pi, ["embed"]);
				if (result.code === 0) {
					ctx.ui.notify("Embeddings generated successfully", "info");
				} else {
					ctx.ui.notify(result.stderr || "Embedding failed", "error");
				}
				return;
			}

			if (trimmedArgs === "help") {
				ctx.ui.notify(
					"/qmd [query] - Search\n" +
					"/qmd status - Index status\n" +
					"/qmd collections - List collections\n" +
					"/qmd add <path> - Add collection\n" +
					"/qmd embed - Generate embeddings",
					"info"
				);
				return;
			}

			// Default: search query
			const searchResult = await execQmd(pi, ["query", trimmedArgs, "--json", "-n", "10"]);
			if (searchResult.code !== 0) {
				ctx.ui.notify(searchResult.stderr || "Search failed", "error");
				return;
			}
			
			const results = parseJsonResults(searchResult.stdout);
			if (results.length === 0) {
				ctx.ui.notify(`No results found for: "${trimmedArgs}"`, "warning");
				return;
			}
			
			// Format results as markdown
			const lines = [
				`## 🔍 QMD Search: "${trimmedArgs}"`,
				``,
				`Found ${results.length} results:`,
				``,
			];
			
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				const score = Math.round(r.score * 100);
				lines.push(`### ${i + 1}. ${r.title || r.path} (${score}%)`);
				lines.push(`- **Path:** \`${r.path}\``);
				lines.push(`- **DocID:** \`#${r.docid}\``);
				if (r.snippet) {
					lines.push(`\n> ${r.snippet.trim().split('\n').join('\n> ')}`);
				}
				lines.push(``);
			}
			
			lines.push(`_Use \`qmd_get\` tool to retrieve full content._`);
			
			pi.sendMessage({
				customType: "qmd-info",
				content: lines.join("\n"),
				display: true,
			});
		},
	});

	// ========================================================================
	// /qmd_ui - Full TUI Browser
	// ========================================================================

	pi.registerCommand("qmd_ui", {
		description: "Open the QMD knowledge browser TUI",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("qmd_ui requires interactive mode", "error");
				return;
			}

			const installed = await checkQmdInstalled(pi);
			if (!installed) {
				ctx.ui.notify("QMD not found. Install: brew install oven-sh/bun/bun && bun i -g https://github.com/tobi/qmd", "error");
				return;
			}

			const initialQuery = args?.trim();

			const qmdPath = await findQmdPath(pi);
			if (!qmdPath) {
				ctx.ui.notify("QMD not found. Install: brew install oven-sh/bun/bun && bun i -g https://github.com/tobi/qmd", "error");
				return;
			}

			const termCols = typeof process !== "undefined" && process.stdout?.columns ? process.stdout.columns : 120;
			const termRows = typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : 40;
			const overlayWidth = Math.max(60, Math.floor(termCols * 0.7));
			const overlayHeight = Math.max(16, Math.floor(termRows * 0.7));

			const result = await ctx.ui.custom<QmdBrowserResult>(
				(tui, theme, _kb, done) => {
					return new QmdBrowserComponent(
						tui,
						theme,
						(args) => execQmdDirect(qmdPath, args),
						done,
						initialQuery
					);
				},
				{
					overlay: true,
					overlayOptions: {
						width: overlayWidth,
						maxHeight: overlayHeight,
						anchor: "center",
					},
				}
			);
			

			if (result?.action === "load") {
				const docResult = await execQmd(pi, ["get", result.doc.path, "--full"]);
				if (docResult.code === 0) {
					pi.sendMessage({
						customType: "qmd-document",
						content: `## ${result.doc.title || result.doc.path}\n\n${docResult.stdout}`,
						display: true,
						details: { path: result.doc.path, docid: result.doc.docid },
					});
					ctx.ui.notify(`Loaded: ${result.doc.path}`, "info");
				} else {
					ctx.ui.notify(docResult.stderr || "Failed to load document", "error");
				}
			}
		},
	});

	// ========================================================================
	// Message Renderer
	// ========================================================================

	pi.registerMessageRenderer("qmd-info", (message, _options, _theme) => {
		const mdTheme = getMarkdownTheme();
		return new Markdown(messageText(message.content), 0, 0, mdTheme);
	});

	pi.registerMessageRenderer("qmd-document", (message, options, theme) => {
		const { expanded } = options;
		const details = (message.details || {}) as { path?: string; docid?: string };
		
		let text = theme.fg("accent", `📚 QMD Document: ${details.path || "unknown"}\n`);
		if (details.docid) {
			text += theme.fg("muted", `DocID: #${details.docid}\n`);
		}
		text += "\n";
		
		// Show content with optional truncation
		const content = messageText(message.content);
		if (!expanded && content.length > 500) {
			text += content.slice(0, 500) + theme.fg("muted", "...\n(Press Ctrl+O to expand)");
		} else {
			text += content;
		}
		
		return new Text(text, 0, 0);
	});

	// ========================================================================
	// Session Start - Check QMD
	// ========================================================================

	pi.on("session_start", async (_event, ctx) => {
		const installed = await checkQmdInstalled(pi);
		if (!installed && ctx.hasUI) {
			ctx.ui.setWidget("qmd-warning", [
				ctx.ui.theme.fg("warning", "⚠ QMD not found. Install: brew install oven-sh/bun/bun && bun i -g https://github.com/tobi/qmd")
			]);
			// Clear after 10 seconds
			setTimeout(() => {
				ctx.ui.setWidget("qmd-warning", undefined);
			}, 10000);
		}
	});
}
