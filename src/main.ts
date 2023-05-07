import { Plugin, TFile, TFolder, TAbstractFile, Notice, Keymap, EventRef } from 'obsidian';
import { DEFAULT_SETTINGS, ExcludedFolder, FolderNotesSettings, SettingsTab } from './settings';
import FolderNameModal from './modals/folderName';
import { applyTemplate } from './template';
import { Commands } from './commands';
import DeleteConfirmationModal from './modals/deleteConfirmation';
import { FileExplorerWorkspaceLeaf } from './globals';

export default class FolderNotesPlugin extends Plugin {
	observer: MutationObserver;
	settings: FolderNotesSettings;
	settingsTab: SettingsTab;
	activeFolderDom: HTMLElement | null;
	activeFileExplorer: FileExplorerWorkspaceLeaf;
	private renamingEvent: EventRef;

	async onload() {
		console.log('loading folder notes plugin');
		await this.loadSettings();
		this.settingsTab = new SettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		// Add CSS Classes
		document.body.classList.add('folder-notes-plugin');
		if (this.settings.hideFolderNote) { document.body.classList.add('hide-folder-note'); }
		if (this.settings.underlineFolder) { document.body.classList.add('folder-note-underline'); }
		if (this.settings.underlineFolderInPath) { document.body.classList.add('folder-note-underline-path'); }
		if (!this.settings.allowWhitespaceCollapsing) { document.body.classList.add('fn-whitespace-stop-collapsing'); }

		new Commands(this.app, this).registerCommands();

		this.observer = new MutationObserver((mutations: MutationRecord[]) => {
			mutations.forEach((rec) => {
				if (rec.type === 'childList') {
					(<Element>rec.target).querySelectorAll('div.nav-folder-title-content')
					.forEach((element: HTMLElement) => {
						if (element.onclick) return;
						element.onclick = (event: MouseEvent) => this.handleFolderClick(event);
					});
					(<Element>rec.target).querySelectorAll('span.view-header-breadcrumb')
					.forEach((element: HTMLElement) => {
						const breadcrumbs = element.parentElement?.querySelectorAll('span.view-header-breadcrumb');
						if (!breadcrumbs) return;
						let path = '';
						breadcrumbs.forEach((breadcrumb: HTMLElement) => {
								path += breadcrumb.innerText.trim() + '/';
								breadcrumb.setAttribute('data-path', path.slice(0, -1));
								const folderNoteName = this.getFolderNoteName(this.getNameFromPathString(path.slice(0, -1)));
								if (this.app.vault.getAbstractFileByPath(path +  folderNoteName + '.md')) {
									breadcrumb.classList.add('has-folder-note');
								}
							});
							element.parentElement?.setAttribute('data-path', path.slice(0, -1));
							if (breadcrumbs.length > 0) {
								breadcrumbs.forEach((breadcrumb: HTMLElement) => {
									if (breadcrumb.onclick) return;
									breadcrumb.onclick = (event: MouseEvent) => this.handleViewHeaderClick(event);
								});
							}
						});
				}
			});
		});
		this.observer.observe(document.body, {
			childList: true,
			subtree: true,
		});
		this.registerEvent(this.app.workspace.on('layout-change', () => { this.loadFileClasses(); }));
		this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
			if (!(file instanceof TFile)) { return; }
			// parent is null here even if the parent exists
			// not entirely sure why
			const parentPath = this.getPathFromString(file.path);
			const parentName = this.getNameFromPathString(parentPath);

			if(this.isFolderNote(file.basename, parentName)) {
				this.removeCSSClassFromEL(parentPath, 'has-folder-note');
			}
		}));
		this.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => {
			if (!this.app.workspace.layoutReady) return;
			if (file instanceof TFile) { return this.handleFileCreate(file); }
			if (!this.settings.autoCreate) return;
			if (!(file instanceof TFolder)) return;

			const excludedFolder = this.getExcludedFolderByPath(file.path);
			if (excludedFolder?.disableAutoCreate) return;

			const folderNoteName = this.getFolderNoteName(file.name);
			const path = file.path + '/' + folderNoteName + '.md';
			const folderNote = this.app.vault.getAbstractFileByPath(path);
			if (folderNote) return;
			this.createFolderNote(path, true, true);
			this.addCSSClassToTitleEL(file.path, 'has-folder-note');

		}));

		this.registerEvent(this.app.workspace.on('file-open', (openFile: TFile | null) => {
			if (this.activeFolderDom) {
				this.activeFolderDom.removeClass('is-active');
				this.activeFolderDom = null;
			}
			if (!openFile || !openFile.basename) { return; }
			if (openFile.basename !== openFile.parent.name) { return; }
			this.activeFolderDom = this.getEL(openFile.parent.path);
			if (this.activeFolderDom) this.activeFolderDom.addClass('is-active');
		}));

		this.renamingEvent = this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
			if (!this.settings.syncFolderName) {
				// cleanup after ourselves
				this.removeCSSClassFromEL(file.path, 'has-folder-note');
				this.removeCSSClassFromEL(file.path, 'is-folder-note');
				return;
			}
			if (file instanceof TFolder) {
				return this.handleFolderRename(file, oldPath);
			} else if (file instanceof TFile) {
				console.log(file, oldPath); // using prefix method: create a folder note, rename file breaking prefix, warning shown, create new folder note, rename correctly (keeping prefix), warning shown because it stills monitors previous file renamed
				return this.handleFileRename(file, oldPath);
			}
		});

		if (!this.app.workspace.layoutReady) {
			this.app.workspace.onLayoutReady(async () => this.loadFileClasses());
		}
	}

	async handleFolderClick(event: MouseEvent) {
		if (!(event.target instanceof HTMLElement)) return;
		event.stopImmediatePropagation();

		const folder = event.target.parentElement?.getAttribute('data-path');
		if (!folder) { return; }
		const excludedFolder = this.getExcludedFolderByPath(folder);
		if (excludedFolder?.disableFolderNote) {
			event.target.onclick = null;
			event.target.click();
			return;
		} else if (excludedFolder?.enableCollapsing || this.settings.enableCollapsing) {
			event.target.onclick = null;
			event.target.click();
		}
		const folderNoteName = this.getFolderNoteName(event.target.innerText);
		const path = folder + '/' + folderNoteName + '.md';
		if (this.app.vault.getAbstractFileByPath(path)) {
			return this.openFolderNote(path, event);
		} else if (event.altKey || Keymap.isModEvent(event) === 'tab') {
			if ((this.settings.altKey && event.altKey) || (this.settings.ctrlKey && Keymap.isModEvent(event) === 'tab')) {
				await this.createFolderNote(path, true, true);
				this.addCSSClassToTitleEL(folder, 'has-folder-note');
				this.removeCSSClassFromEL(folder, 'has-not-folder-note');
				return;
			}
		}
		event.target.onclick = null;
		event.target.click();
	}

	async handleViewHeaderClick(event: MouseEvent) {
		if (!(event.target instanceof HTMLElement)) return;
		if (!this.settings.openFolderNoteOnClickInPath) return;
		const folder = event.target.getAttribute('data-path');
		if (!folder) { return; }
		const excludedFolder = this.getExcludedFolderByPath(folder);
		if (excludedFolder?.disableFolderNote) {
			event.target.onclick = null;
			event.target.click();
			return;
		} else if (excludedFolder?.enableCollapsing || this.settings.enableCollapsing) {
			event.target.onclick = null;
			event.target.click();
		}
		const folderNoteName = this.getFolderNoteName(event.target.innerText);
		const path = folder + '/' + folderNoteName + '.md';
		if (this.app.vault.getAbstractFileByPath(path)) {
			return this.openFolderNote(path, event);
		} else if (event.altKey || Keymap.isModEvent(event) === 'tab') {
			if ((this.settings.altKey && event.altKey) || (this.settings.ctrlKey && Keymap.isModEvent(event) === 'tab')) {
				await this.createFolderNote(path, true, true);
				this.addCSSClassToTitleEL(folder, 'has-folder-note');
				this.removeCSSClassFromEL(folder, 'has-not-folder-note');
				return;
			}
		}
		event.target.onclick = null;
		event.target.click();
	}

	handleFolderRename(file: TFolder, oldPath: string) {
		const oldFileName = this.getNameFromPathString(oldPath);

		const folder = this.app.vault.getAbstractFileByPath(file.path);
		if (!folder) return;
		const excludedFolders = this.settings.excludeFolders.filter(
			(excludedFolder) => excludedFolder.path.includes(oldPath)
		);

		excludedFolders.forEach((excludedFolder) => {
			if (excludedFolder.path === oldPath) {
				excludedFolder.path = folder.path;
				return;
			}
			const folders = excludedFolder.path.split('/');
			if (folders.length < 1) {
				folders.push(excludedFolder.path);
			}

			folders[folders.indexOf(oldFileName)] = folder.name;
			excludedFolder.path = folders.join('/');
		});
		this.saveSettings();
		const excludedFolder = this.getExcludedFolderByPath(oldPath);
		if (excludedFolder?.disableSync) return;

		const oldFolderNoteName = this.getFolderNoteName(oldFileName);
		const folderNoteName = this.getFolderNoteName(folder.name);

		const newPath = folder.path + '/' + folderNoteName + '.md';
		if (!(folder instanceof TFolder)) return;
		const note = this.app.vault.getAbstractFileByPath(oldPath + '/' + oldFolderNoteName + '.md');
		if (!note) return;
		(note as TFile).path = folder.path + '/' + oldFolderNoteName + '.md';
		this.app.vault.rename(note, newPath);
	}

	handleFileRename(file: TFile, oldPath: string) {
		const oldFileName = this.getNameFromPathString(oldPath);
		const oldFilePath = this.getPathFromString(oldPath);
		const oldFolder = this.app.vault.getAbstractFileByPath(oldFilePath);

		const newFilePath = this.getPathFromString(file.path);
		const newFolder = this.app.vault.getAbstractFileByPath(newFilePath);

		if (oldFolder) {
			const excludedFolder = this.getExcludedFolderByPath(oldFolder.path);
			if (excludedFolder?.disableSync) {
				this.removeCSSClassFromEL(oldFolder.path, 'has-folder-note');
				this.removeCSSClassFromEL(file.path, 'is-folder-note');
				this.removeCSSClassFromEL(oldPath, 'is-folder-note');
			}
			// nothing else for us to do as we have no new folder to action on
			if (!newFolder) { return; }

			const newExcludedFolder = this.getExcludedFolderByPath(newFolder.path);
			// Nothing else for us to do
			if (newExcludedFolder?.disableSync || newExcludedFolder?.disableFolderNote) { return; }
		}

		if(this.settings.namingMethod == 'index' && file.basename !== this.settings.namingMethodIndex) {
			this.loadFileClasses(true);
			new Notice(`Renamed note is no longer the folder note: needs to be named ${this.settings.namingMethodIndex}`);
			return;
		} else if(this.settings.namingMethod == 'prefix' && !file.basename.startsWith(this.settings.namingMethodPrefix)) {
			this.loadFileClasses(true);
			new Notice(`Renamed note is no longer the folder note: has to start with ${this.settings.namingMethod}`);
			return;
		}

		// file matched folder name before rename
		// file hasnt moved just renamed
		// Need to rename the folder
		if (oldFolder && this.isFolderNote(oldFileName.slice(0,-3), oldFolder.name) && newFilePath === oldFilePath) {
			return this.renameFolderOnFileRename(file, oldPath, oldFolder);
		}

		// the note has been moved somewhere and is no longer a folder note
		// cleanup css on the folder and note
		if (oldFolder && this.isFolderNote(oldFileName.slice(0,-3), oldFolder.name) && newFilePath !== oldFilePath) {
			this.removeCSSClassFromEL(oldFolder.path, 'has-folder-note');
			this.removeCSSClassFromEL(file.path, 'is-folder-note');
			this.removeCSSClassFromEL(oldPath, 'is-folder-note');
		}

		// file has been moved into position where it can be a folder note!
		if (newFolder && this.isFolderNote(file.basename, newFolder.name)) {
			this.addCSSClassToTitleEL(newFolder.path, 'has-folder-note');
			this.addCSSClassToTitleEL(file.path, 'is-folder-note', true);
		}
	}

	async renameFolderOnFileRename(file: TFile, oldPath: string, oldFolder: TAbstractFile) {
		const newFolderPath = oldFolder.parent.path + '/' + this.getFilenameWithoutPrefix(file.basename);
		if (this.app.vault.getAbstractFileByPath(newFolderPath)) {
			await this.app.vault.rename(file, oldPath);
			return new Notice('A folder with the same name already exists');
		}
		await this.app.vault.rename(oldFolder, newFolderPath);
	}

	handleFileCreate(file: TFile) {
		if (!this.isFolderNote(file.basename, file.parent.name)) { return; }
		this.addCSSClassToTitleEL(file.parent.path, 'has-folder-note');
		this.addCSSClassToTitleEL(file.path, 'is-folder-note', true);
	}

	async createFolderNote(path: string, openFile: boolean, useModal?: boolean) {
		const leaf = this.app.workspace.getLeaf(false);
		const file = await this.app.vault.create(path, '');
		if (openFile) {
			await leaf.openFile(file);
		}
		if (file) {
			applyTemplate(this, file, this.settings.templatePath);
		}
		if (!this.settings.autoCreate) return;
		if (!useModal) return;
		const folder = this.app.vault.getAbstractFileByPath(this.getPathFromString(path));
		if (!(folder instanceof TFolder)) return;
		const modal = new FolderNameModal(this.app, this, folder);
		modal.open();
		this.addCSSClassToTitleEL(path, 'is-folder-note', true);
	}

	async openFolderNote(path: string, evt: MouseEvent) {
		const leaf = this.app.workspace.getLeaf(Keymap.isModEvent(evt));
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await leaf.openFile(file);
		}
	}

	async deleteFolderNote(file: TFile) {
		if (this.settings.showDeleteConfirmation) {
			return new DeleteConfirmationModal(this.app, this, file).open();
		}
		await this.app.vault.delete(file);
	}

	getNameFromPathString(path: string): string {
		return path.substring(path.lastIndexOf('/' || '\\') >= 0 ? path.lastIndexOf('/' || '\\') + 1 : 0);
	}

	getPathFromString(path: string): string {
		const subString = path.lastIndexOf('/' || '\\') >= 0 ? path.lastIndexOf('/') : path.length;
		return path.substring(0, subString);
	}

	getExcludedFolderByPath(path: string): ExcludedFolder | undefined {
		return this.settings.excludeFolders.find((excludedFolder) => {
			if (excludedFolder.path === path) { return true; }
			if (!excludedFolder.subFolders) { return false; }
			return this.getPathFromString(path).startsWith(excludedFolder.path);
		});
	}

	getFileExplorer() {
		return this.app.workspace.getLeavesOfType('file-explorer')[0] as FileExplorerWorkspaceLeaf;
	}

	getFileExplorerView() {
		return this.getFileExplorer().view;
	}

	getFolderNoteName(folderName: string): string {
		if(this.settings.namingMethod == "index") {
			return this.settings.namingMethodIndex;
		}
		if(this.settings.namingMethod == "prefix") {
			return this.settings.namingMethodPrefix + folderName;
		}
		return folderName;
	}

	getFilenameWithoutPrefix(folderNoteName: string): string {
		if(this.settings.namingMethod == "prefix" && folderNoteName.startsWith(this.settings.namingMethodPrefix)) {
			return folderNoteName.substring(this.settings.namingMethodPrefix.length);
		}
		return folderNoteName;
	}

	isFolderNote(fileName: string, parentName: string): boolean {
		if(
			(this.settings.namingMethod === "foldername" && fileName === parentName)
			||
			(this.settings.namingMethod === "prefix" && fileName === this.settings.namingMethodPrefix + parentName)
			||
			(this.settings.namingMethod === "index" && fileName === this.settings.namingMethodIndex)
		) return true;
		return false;
	}

	async addCSSClassToTitleEL(path: string, cssClass: string, waitForCreate = false, count = 0) {
		const fileExplorerItem = this.getEL(path);
		if (!fileExplorerItem) {
			if (waitForCreate && count < 5) {
				// sleep for a second for the file-explorer event to catch up
				// this is annoying as in most scanarios our plugin recieves the event before file explorer
				// If we could guarrantee load order it wouldn't be an issue but we can't
				// realise this is racey and needs to be fixed.
				await new Promise((r) => setTimeout(r, 500));
				this.addCSSClassToTitleEL(path, cssClass, waitForCreate, count + 1);
				return;
			}
			return;
		}
		fileExplorerItem.addClass(cssClass);
		const viewHeaderItems = document.querySelectorAll(`[data-path="${path}"]`);
		viewHeaderItems.forEach((item) => {
			item.addClass(cssClass);
		});
	}

	removeCSSClassFromEL(path: string, cssClass: string) {
		const fileExplorerItem = this.getEL(path);
		const viewHeaderItems = document.querySelectorAll(`[data-path="${path}"]`);
		viewHeaderItems.forEach((item) => {
			item.removeClass(cssClass);
		});
		if (!fileExplorerItem) { return; }
		fileExplorerItem.removeClass(cssClass);
	}

	removeFolderNotesClasses() {
		document.querySelectorAll('.is-folder-note, .has-folder-note').forEach((item) => {
			item.removeClasses(['is-folder-note', 'has-folder-note']);
		});
	}

	validateFilename(filename: string): boolean {
		const rgx = /[*\\/:"<>|?]/;
		return !rgx.test(filename);
	}

	getEL(path: string): HTMLElement | null {
		const fileExplorer = this.getFileExplorer();
		if (!fileExplorer) { return null; }
		const fileExplorerItem = fileExplorer.view.fileItems[path];
		if (!fileExplorerItem) { return null; }
		if (fileExplorerItem.selfEl) return fileExplorerItem.selfEl;
		return fileExplorerItem.titleEl;
	}

	loadFileClasses(forceReload = false) {
		if (this.activeFileExplorer === this.getFileExplorer() && !forceReload) { return; }
		this.activeFileExplorer = this.getFileExplorer();
		this.removeFolderNotesClasses();
		this.app.vault.getMarkdownFiles().forEach((file) => {
			if(this.isFolderNote(file.basename, file.parent.name)) {
				const excludedFolder = this.getExcludedFolderByPath(file.parent.path);
				// cleanup after ourselves
				// Incase settings have changed
				if (excludedFolder?.disableFolderNote) {
					this.removeCSSClassFromEL(file.path, 'is-folder-note');
					this.removeCSSClassFromEL(file.parent.path, 'has-folder-note');
					return;
				}
				this.addCSSClassToTitleEL(file.parent.path, 'has-folder-note');
				this.addCSSClassToTitleEL(file.path, 'is-folder-note');
			}
		});
	}

	onunload() {
		console.log('unloading folder notes plugin');
		this.observer.disconnect();
		document.body.classList.remove('folder-notes-plugin');
		document.body.classList.remove('folder-note-underline');
		document.body.classList.remove('hide-folder-note');
		document.body.classList.remove('fn-whitespace-stop-collapsing');
		if (this.activeFolderDom) { this.activeFolderDom.removeClass('is-active'); }
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// cleanup any css if we need too
		this.loadFileClasses(true);
	}
}
