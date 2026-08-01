import { Plugin, Notice } from "obsidian";
import { InsightASettingTab, InsightASettings, DEFAULT_SETTINGS } from "src/settings";
import { DEFAULT_PROMPT_TEMPLATE } from 'src/template';
import { ViewManager } from "src/view-manager";
import { ChatGPT } from 'src/api';
import { Embed } from 'src/embed';
import { extractJsonArray, isPlainObject } from 'src/json-parse';

enum InputMode {
	SelectedText,
	FullContent
}

export default class InsightAPlugin extends Plugin {
	settings: InsightASettings;
	embedManager: Embed;
	viewManager = new ViewManager(this.app);

	async onload() {
		await this.loadSettings();
		process.env.OPENAI_API_KEY = this.settings.commandOption.openai_key;
		this.embedManager = new Embed(this.app, this.viewManager, this.settings);

		this.registerPluginCommands();
		this.addSettingTab(new InsightASettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	saveSettingsNow() {
		this.saveData(this.settings);
	}

	onunload() {}

	private registerPluginCommands() {
		this.addCommand({
			id: 'create-notes-from-selection',
			name: 'Create Notes from Selected Text',
			callback: () => this.extractNotes(InputMode.SelectedText)
		});
		this.addCommand({
			id: 'create-notes-from-content',
			name: 'Create Notes from Full Content',
			callback: () => this.extractNotes(InputMode.FullContent)
		});
		this.addCommand({
			id: 'update-map-of-content',
			name: 'Update Map of Content',
			callback: () => this.updateMapOfContent()
		});
	}

	private async extractNotes(inputMode: InputMode) {
		const loadingNotice = this.showLoadingNotice(`${this.manifest.name}: Processing...`);
		try {
			await this.processNotes(inputMode);
		} catch (err) {
			console.error(err);
		} finally {
			loadingNotice.hide();
		}
	}

	private async processNotes(inputMode: InputMode) {
		if (!this.isApiKeyAvailable()) {
			return;
		}

		const noteInput = await this.getNoteInput(inputMode);
		if (!noteInput) {
			new Notice(`⛔ ${this.manifest.name}: No input data`);
			return;
		}

		const noteTitle = await this.viewManager.getTitle() ?? "Untitled";
		const userPrompt = this.generateUserPrompt(noteInput);
		const systemPrompt = this.generateSystemPrompt();

		try {
			const notesArray = await this.fetchNotesFromApi(systemPrompt, userPrompt);
			await this.createNotesFromArray(notesArray, noteTitle);
			new Notice(`✅ ${this.manifest.name}: Finished`);
		} catch (error) {
			console.error(error);
			new Notice(`⛔ ${this.manifest.name}: Failed to extract notes`);
		}
	}

	private isApiKeyAvailable(): boolean {
		if (!process.env.OPENAI_API_KEY) {
			new Notice(`⛔ ${this.manifest.name}: You need to input your API Key`);
			return false;
		}
		return true;
	}

	private async getNoteInput(inputMode: InputMode): Promise<string | null> {
		if (inputMode === InputMode.SelectedText) {
			return await this.viewManager.getSelection();
		} else if (inputMode === InputMode.FullContent) {
			return await this.viewManager.getContent();
		}
		return null;
	}

	private generateUserPrompt(input: string): string {
		let userPrompt = DEFAULT_PROMPT_TEMPLATE;
		return userPrompt.replace('{{input}}', input);
	}

	private generateSystemPrompt(): string {
		const { system_role, notes_quantity, tags_quantity, language_option, specific_language, properties } = this.settings.commandOption;
		return system_role
			.replace(/{{number_of_notes}}/g, notes_quantity.toString())
			.replace(/{{number_of_tags}}/g, tags_quantity.toString())
			.replace(/{{language}}/g, language_option === 'specific' ? specific_language : language_option)
			.replace(/{{properties}}/g, properties);
	}

	private async fetchNotesFromApi(systemPrompt: string, userPrompt: string): Promise<any[]> {
		const response = await ChatGPT.callAPI(systemPrompt, userPrompt, this.settings.commandOption.llm_model);

		let values: unknown[];
		try {
			values = extractJsonArray(response);
		} catch (error) {
			console.error(`${this.manifest.name}: no JSON in LLM response:\n${response}`);
			throw error;
		}

		const notes = values.filter(value => this.isNoteLike(value));
		if (notes.length === 0) {
			console.error(`${this.manifest.name}: no notes in LLM response:\n${response}`);
			throw new Error("LLM response contains no notes");
		}
		if (notes.length < values.length) {
			console.warn(`${this.manifest.name}: skipped ${values.length - notes.length} malformed note(s)`);
		}
		return notes;
	}

	private isNoteLike(value: unknown): boolean {
		return isPlainObject(value) && (typeof value.title === "string" || typeof value.body === "string");
	}

	private async createNotesFromArray(notesArray: any[], title: string) {
		for (const note of notesArray) {
			const tags = this.formatTags(note.tags);
			const noteContent = this.buildNoteContent(note, title, tags);
			const notePath = `${this.settings.commandOption.generated_notes_location}/${this.noteFileName(note)}.md`;
			try {
				await this.app.vault.create(notePath, noteContent);
			} catch (error) {
				console.error(`Failed to create note at ${notePath}:`, error);
				new Notice(`⛔ Failed to create note: ${note.title}`);
			}
		}
	}

	// The model decides the file name, so strip what a vault path cannot contain.
	private noteFileName(note: any): string {
		const title = typeof note.title === "string" ? note.title.trim() : "";
		return (title || "Untitled").replace(/[\\/:*?"<>|#^[\]]/g, "").slice(0, 100).trim() || "Untitled";
	}

	// Tags may come back missing, as a single comma separated string, or as an array.
	private formatTags(tags: unknown): string {
		const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(",") : [];
		return list
			.map(tag => String(tag).trim().replace(/ /g, "_").replace(/#/g, ""))
			.filter(tag => tag !== "")
			.join(', ');
	}

	private buildNoteContent(note: any, title: string, tags: string): string {
		let content = `---\nsource: "[[${title}]]"\ntags: ${tags}\n`;
		if (isPlainObject(note.properties)) {
			for (const [key, value] of Object.entries(note.properties)) {
				if (value !== null) {
					content += `${key}: ${Array.isArray(value) ? JSON.stringify(value) : value}\n`;
				}
			}
		}
		content += `---\n${note.body ?? ""}`;
		return content;
	}

	private async updateMapOfContent() {
		if (!this.isApiKeyAvailable()) {
			return;
		}

		const noteTitle = await this.viewManager.getTitle();
		if (!noteTitle) {
			new Notice("⛔ Unable to retrieve title");
			return;
		}

		await this.embedManager.saveEmbeddings();
		await this.embedManager.searchRelatedNotes(noteTitle, noteTitle);
		new Notice(`✅ ${this.manifest.name}: Finished`);
	}

	private showLoadingNotice(text: string, duration = 100000): Notice {
		const notice = new Notice('', duration);
		const loadingContainer = document.createElement('div');
		loadingContainer.addClass('loading-container');

		const loadingIcon = document.createElement('div');
		loadingIcon.addClass('loading-icon');
		const loadingText = document.createElement('span');
		loadingText.textContent = text;
		//@ts-ignore
		notice.noticeEl.empty();
		loadingContainer.appendChild(loadingIcon);
		loadingContainer.appendChild(loadingText);
		//@ts-ignore
		notice.noticeEl.appendChild(loadingContainer);

		return notice;
	}

}
