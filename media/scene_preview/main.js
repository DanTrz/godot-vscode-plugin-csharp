// @ts-check

/**
 * Scene Preview WebView JavaScript
 * Handles tree rendering, search, drag-and-drop, and context menus
 */

(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	/** @type {any} */
	let currentTreeData = null;

	/** @type {string} */
	let currentScenePath = "";

	/** @type {string} */
	let currentSearchQuery = "";

	/** @type {any} */
	let selectedNode = null;

	/** @type {Set<string>} - Tracks COLLAPSED nodes (all expanded by default) */
	const collapsedNodes = new Set();

	/** @type {string} */
	let darkIconsBaseUri = "";

	/** @type {string} */
	let lightIconsBaseUri = "";

	/** @type {Array<{fsPath: string, displayName: string, resPath: string}>} */
	let sceneList = [];

	/** @type {boolean} */
	let dropdownOpen = false;

	/** @type {string} */
	let dropdownFilter = "";

	/** @type {number} */
	let dropdownHighlightIndex = -1;

	// DOM elements
	const searchInput = /** @type {HTMLInputElement} */ (document.getElementById("searchInput"));
	const clearButton = document.getElementById("clearSearch");
	const treeContainer = document.getElementById("treeContainer");
	const contextMenu = document.getElementById("contextMenu");

	// Scene selector elements
	const sceneSelector = document.getElementById("sceneSelector");
	const sceneSelectorTrigger = document.getElementById("sceneSelectorTrigger");
	const sceneSelectorLabel = document.getElementById("sceneSelectorLabel");
	const sceneSelectorDropdown = document.getElementById("sceneSelectorDropdown");
	const sceneSelectorFilter = /** @type {HTMLInputElement} */ (document.getElementById("sceneSelectorFilter"));
	const sceneSelectorList = document.getElementById("sceneSelectorList");

	// Debounce timer for search
	let searchDebounceTimer = null;

	/**
	 * Initialize the WebView
	 */
	function init() {
		setupEventListeners();
		// Notify extension that we're ready
		vscode.postMessage({ type: "ready" });
	}

	/**
	 * Set up all event listeners
	 */
	function setupEventListeners() {
		// Search input - real-time filtering
		searchInput.addEventListener("input", (e) => {
			const query = /** @type {HTMLInputElement} */ (e.target).value;
			currentSearchQuery = query;

			// Show/hide clear button
			clearButton.style.opacity = query ? "0.6" : "0";

			// Debounce search
			if (searchDebounceTimer) {
				clearTimeout(searchDebounceTimer);
			}
			searchDebounceTimer = setTimeout(() => {
				vscode.postMessage({ type: "search", query });
			}, 150);
		});

		// Clear button
		clearButton.addEventListener("click", () => {
			searchInput.value = "";
			currentSearchQuery = "";
			clearButton.style.opacity = "0";
			vscode.postMessage({ type: "search", query: "" });
			searchInput.focus();
		});

		// Escape key clears search
		searchInput.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				searchInput.value = "";
				currentSearchQuery = "";
				clearButton.style.opacity = "0";
				vscode.postMessage({ type: "search", query: "" });
			}
		});

		// Scene selector dropdown
		sceneSelectorTrigger.addEventListener("click", (e) => {
			e.stopPropagation();
			toggleDropdown();
		});

		sceneSelectorFilter.addEventListener("input", (e) => {
			dropdownFilter = /** @type {HTMLInputElement} */ (e.target).value;
			dropdownHighlightIndex = -1;
			renderDropdownList();
		});

		sceneSelectorFilter.addEventListener("keydown", (e) => {
			e.stopPropagation();
			const filtered = getFilteredScenes();
			switch (e.key) {
				case "ArrowDown":
					e.preventDefault();
					dropdownHighlightIndex = Math.min(dropdownHighlightIndex + 1, filtered.length - 1);
					renderDropdownList();
					scrollHighlightedIntoView();
					break;
				case "ArrowUp":
					e.preventDefault();
					dropdownHighlightIndex = Math.max(dropdownHighlightIndex - 1, 0);
					renderDropdownList();
					scrollHighlightedIntoView();
					break;
				case "Enter":
					e.preventDefault();
					if (dropdownHighlightIndex >= 0 && dropdownHighlightIndex < filtered.length) {
						selectScene(filtered[dropdownHighlightIndex].fsPath);
					} else if (filtered.length === 1) {
						selectScene(filtered[0].fsPath);
					}
					break;
				case "Escape":
					e.preventDefault();
					closeDropdown();
					break;
			}
		});

		// Close context menu and dropdown on click outside
		document.addEventListener("click", (e) => {
			if (!contextMenu.contains(/** @type {Node} */ (e.target))) {
				hideContextMenu();
			}
			if (dropdownOpen && !sceneSelector.contains(/** @type {Node} */ (e.target))) {
				closeDropdown();
			}
		});

		// Handle messages from extension
		window.addEventListener("message", (event) => {
			const message = event.data;
			handleMessage(message);
		});
	}

	/**
	 * Handle messages from the extension
	 * @param {any} message
	 */
	function handleMessage(message) {
		switch (message.type) {
			case "updateTree":
				currentTreeData = message.tree;
				currentScenePath = message.scenePath;
				updateSelectorLabel(message.sceneTitle || "", message.scenePath || "");
				darkIconsBaseUri = message.darkIconsBaseUri || "";
				lightIconsBaseUri = message.lightIconsBaseUri || "";
				renderTree();
				break;

			case "searchResults":
				darkIconsBaseUri = message.darkIconsBaseUri || darkIconsBaseUri;
				lightIconsBaseUri = message.lightIconsBaseUri || lightIconsBaseUri;
				renderSearchResults(message.results, message.query);
				break;

			case "clear":
				currentTreeData = null;
				currentScenePath = "";
				updateSelectorLabel("", "");
				treeContainer.innerHTML = '<div class="welcome-message">Open a Scene to see a preview of its structure</div>';
				break;

			case "updateSceneList": {
				sceneList = message.scenes || [];
				currentScenePath = message.currentScenePath || currentScenePath;
				renderDropdownList();
				const current = sceneList.find(s => s.fsPath === currentScenePath);
				if (current) {
					updateSelectorLabel(current.displayName, current.fsPath);
				}
				break;
			}

			case "lockStateChanged":
				// Could update UI to show lock state
				break;
		}
	}

	/**
	 * Get icon URI for a Godot class name
	 * @param {string} className
	 * @returns {string|null}
	 */
	function getIconUri(className) {
		if (!darkIconsBaseUri) return null;
		return `${darkIconsBaseUri}/${className}.svg`;
	}

	/**
	 * Create icon element with fallback
	 * @param {string} className
	 * @returns {HTMLElement}
	 */
	function createIconElement(className) {
		const iconElement = document.createElement("span");
		iconElement.className = "node-icon";

		const iconUri = getIconUri(className);
		if (iconUri) {
			const img = document.createElement("img");
			img.src = iconUri;
			img.alt = className;
			img.onerror = () => {
				// Fallback to codicon if icon doesn't exist
				img.style.display = "none";
				const fallback = document.createElement("span");
				fallback.className = "codicon codicon-symbol-class";
				iconElement.appendChild(fallback);
			};
			iconElement.appendChild(img);
		} else {
			iconElement.innerHTML = '<span class="codicon codicon-symbol-class"></span>';
		}

		return iconElement;
	}

	/**
	 * Render the hierarchical tree
	 */
	function renderTree() {
		if (!currentTreeData) {
			treeContainer.innerHTML = '<div class="welcome-message">Open a Scene to see a preview of its structure</div>';
			return;
		}

		treeContainer.innerHTML = "";
		const treeElement = createTreeNode(currentTreeData, 0);
		treeContainer.appendChild(treeElement);
	}

	/**
	 * Create a tree node element
	 * @param {any} node
	 * @param {number} depth
	 * @returns {HTMLElement}
	 */
	function createTreeNode(node, depth) {
		if (!node) {
			const errorEl = document.createElement("div");
			errorEl.className = "tree-node error";
			errorEl.textContent = "Error: null node";
			return errorEl;
		}

		const nodeElement = document.createElement("div");
		nodeElement.className = "tree-node";
		nodeElement.dataset.path = node.path;

		const contentElement = document.createElement("div");
		contentElement.className = "tree-node-content" + (node.fromInstance ? " from-instance" : "");
		contentElement.draggable = true;

		// Expand icon
		const expandIcon = document.createElement("span");
		expandIcon.className = "expand-icon";
		if (node.hasChildren) {
			// All nodes expanded by default - collapsedNodes tracks which are collapsed
			const isExpanded = !collapsedNodes.has(node.path);
			expandIcon.className += isExpanded ? "" : " collapsed";
			expandIcon.innerHTML = '<span class="codicon codicon-chevron-down"></span>';
			expandIcon.addEventListener("click", (e) => {
				e.stopPropagation();
				toggleNodeExpansion(node.path, nodeElement);
			});
		} else {
			expandIcon.className += " no-children";
		}
		contentElement.appendChild(expandIcon);

		// Node icon (actual Godot class icon with fallback)
		const iconElement = createIconElement(node.className);
		contentElement.appendChild(iconElement);

		// Node label
		const labelElement = document.createElement("span");
		labelElement.className = "node-label";
		labelElement.textContent = node.label;
		contentElement.appendChild(labelElement);

		// Node type
		const typeElement = document.createElement("span");
		typeElement.className = "node-type";
		typeElement.textContent = `(${node.className})`;
		contentElement.appendChild(typeElement);

		// Badges
		const badgesElement = document.createElement("span");
		badgesElement.className = "node-badges";
		if (node.unique) {
			const badge = document.createElement("span");
			badge.className = "badge unique";
			badge.textContent = "%";
			badge.title = "Unique node";
			badgesElement.appendChild(badge);
		}
		if (node.hasScript) {
			const badge = document.createElement("span");
			badge.className = "badge script";
			badge.textContent = "S";
			badge.title = "Has script";
			badgesElement.appendChild(badge);
		}
		if (node.isInstanced) {
			const badge = document.createElement("span");
			badge.className = "badge instanced";
			badge.textContent = "⚡";
			badge.title = "Instanced scene";
			badgesElement.appendChild(badge);
		}
		if (badgesElement.children.length > 0) {
			contentElement.appendChild(badgesElement);
		}

		// Click handler
		contentElement.addEventListener("click", () => {
			selectNode(contentElement, node);
		});

		// Context menu
		contentElement.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			selectNode(contentElement, node);
			showContextMenu(e, node);
		});

		// Drag and drop
		setupDragAndDrop(contentElement, node);

		nodeElement.appendChild(contentElement);

		// Children container
		if (node.hasChildren && node.children) {
			const childrenContainer = document.createElement("div");
			childrenContainer.className = "tree-children";
			// All nodes expanded by default - collapsedNodes tracks which are collapsed
			const isExpanded = !collapsedNodes.has(node.path);
			if (!isExpanded) {
				childrenContainer.className += " collapsed";
			}
			for (const child of node.children) {
				childrenContainer.appendChild(createTreeNode(child, depth + 1));
			}
			nodeElement.appendChild(childrenContainer);
		}

		return nodeElement;
	}

	/**
	 * Toggle node expansion
	 * @param {string} path
	 * @param {HTMLElement} nodeElement
	 */
	function toggleNodeExpansion(path, nodeElement) {
		const expandIcon = nodeElement.querySelector(".expand-icon");
		const childrenContainer = nodeElement.querySelector(".tree-children");

		if (!childrenContainer) return;

		// collapsedNodes tracks collapsed nodes (all expanded by default)
		if (collapsedNodes.has(path)) {
			// Currently collapsed -> expand
			collapsedNodes.delete(path);
			expandIcon.classList.remove("collapsed");
			childrenContainer.classList.remove("collapsed");
		} else {
			// Currently expanded -> collapse
			collapsedNodes.add(path);
			expandIcon.classList.add("collapsed");
			childrenContainer.classList.add("collapsed");
		}
	}

	/**
	 * Render flat search results
	 * @param {any[]} results
	 * @param {string} query
	 */
	function renderSearchResults(results, query) {
		treeContainer.innerHTML = "";

		if (results.length === 0) {
			treeContainer.innerHTML = '<div class="empty-state">No matching nodes found</div>';
			return;
		}

		// Results header
		const header = document.createElement("div");
		header.className = "search-results-header";
		header.textContent = `${results.length} result${results.length === 1 ? "" : "s"}`;
		treeContainer.appendChild(header);

		// Results list
		const resultsContainer = document.createElement("div");
		resultsContainer.className = "search-results";

		for (const node of results) {
			const resultElement = createSearchResultItem(node, query);
			resultsContainer.appendChild(resultElement);
		}

		treeContainer.appendChild(resultsContainer);
	}

	/**
	 * Create a search result item
	 * @param {any} node
	 * @param {string} query
	 * @returns {HTMLElement}
	 */
	function createSearchResultItem(node, query) {
		const itemElement = document.createElement("div");
		itemElement.className = "search-result-item" + (node.fromInstance ? " from-instance" : "");
		itemElement.draggable = true;
		itemElement.dataset.path = node.path;

		// Main row
		const mainRow = document.createElement("div");
		mainRow.className = "search-result-main";

		// Icon (actual Godot class icon with fallback)
		const iconElement = createIconElement(node.className);
		iconElement.className = "search-result-icon";
		mainRow.appendChild(iconElement);

		// Label with highlighting
		const labelElement = document.createElement("span");
		labelElement.className = "search-result-label";
		labelElement.innerHTML = highlightMatch(node.label, query);
		mainRow.appendChild(labelElement);

		// Type with highlighting
		const typeElement = document.createElement("span");
		typeElement.className = "search-result-type";
		typeElement.innerHTML = `(${highlightMatch(node.className, query)})`;
		mainRow.appendChild(typeElement);

		// Badges
		if (node.unique || node.hasScript || node.isInstanced) {
			const badgesElement = document.createElement("span");
			badgesElement.className = "node-badges";
			if (node.unique) {
				const badge = document.createElement("span");
				badge.className = "badge unique";
				badge.textContent = "%";
				badgesElement.appendChild(badge);
			}
			if (node.hasScript) {
				const badge = document.createElement("span");
				badge.className = "badge script";
				badge.textContent = "S";
				badgesElement.appendChild(badge);
			}
			if (node.isInstanced) {
				const badge = document.createElement("span");
				badge.className = "badge instanced";
				badge.textContent = "⚡";
				badgesElement.appendChild(badge);
			}
			mainRow.appendChild(badgesElement);
		}

		itemElement.appendChild(mainRow);

		// Path row
		const pathRow = document.createElement("div");
		pathRow.className = "search-result-path";
		pathRow.textContent = node.relativePath || "(root)";
		itemElement.appendChild(pathRow);

		// Click handler
		itemElement.addEventListener("click", () => {
			selectSearchResult(itemElement, node);
		});

		// Context menu
		itemElement.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			selectSearchResult(itemElement, node);
			showContextMenu(e, node);
		});

		// Drag and drop
		setupDragAndDrop(itemElement, node);

		return itemElement;
	}

	/**
	 * Highlight matching text
	 * @param {string} text
	 * @param {string} query
	 * @returns {string}
	 */
	function highlightMatch(text, query) {
		if (!query) return escapeHtml(text);

		const lowerText = text.toLowerCase();
		const lowerQuery = query.toLowerCase();

		let result = "";
		let textIndex = 0;

		for (const char of lowerQuery) {
			const foundIndex = lowerText.indexOf(char, textIndex);
			if (foundIndex === -1) break;

			// Add non-matching characters
			result += escapeHtml(text.slice(textIndex, foundIndex));
			// Add matching character with highlight
			result += `<span class="match-highlight">${escapeHtml(text[foundIndex])}</span>`;
			textIndex = foundIndex + 1;
		}

		// Add remaining characters
		result += escapeHtml(text.slice(textIndex));
		return result;
	}

	/**
	 * Escape HTML special characters
	 * @param {string} text
	 * @returns {string}
	 */
	function escapeHtml(text) {
		const div = document.createElement("div");
		div.textContent = text;
		return div.innerHTML;
	}

	/**
	 * Select a tree node
	 * @param {HTMLElement} element
	 * @param {any} node
	 */
	function selectNode(element, node) {
		// Deselect previous
		document.querySelectorAll(".tree-node-content.selected").forEach((el) => {
			el.classList.remove("selected");
		});

		element.classList.add("selected");
		selectedNode = node;
		vscode.postMessage({ type: "nodeClick", node });
	}

	/**
	 * Select a search result
	 * @param {HTMLElement} element
	 * @param {any} node
	 */
	function selectSearchResult(element, node) {
		document.querySelectorAll(".search-result-item.selected").forEach((el) => {
			el.classList.remove("selected");
		});

		element.classList.add("selected");
		selectedNode = node;
		vscode.postMessage({ type: "nodeClick", node });
	}

	/**
	 * Set up drag and drop for an element
	 * @param {HTMLElement} element
	 * @param {any} node
	 */
	function setupDragAndDrop(element, node) {
		element.addEventListener("dragstart", (e) => {
			element.classList.add("dragging");

			// Check for Ctrl modifier to use secondary style (Shift conflicts with VSCode drag behavior)
			const useSecondaryStyle = e.ctrlKey;

			// Create drag data for the DocumentDropEditProvider
			const dragData = JSON.stringify({
				name: node.label,
				type: node.className,
				path: node.path,
				relativePath: node.relativePath,
				unique: node.unique,
				scenePath: currentScenePath,
				useSecondaryStyle: useSecondaryStyle,
			});

			// Set the custom MIME type that DocumentDropEditProvider will read
			e.dataTransfer.setData("application/vnd.code.tree.godotTools.scenePreview", dragData);
			e.dataTransfer.setData("text/plain", node.label);
			e.dataTransfer.effectAllowed = "copy";

			// Create a drag image with visual feedback for secondary style
			const dragImage = document.createElement("div");
			dragImage.style.cssText = `
				position: fixed;
				background: var(--vscode-list-activeSelectionBackground);
				color: var(--vscode-list-activeSelectionForeground);
				padding: 4px 8px;
				border-radius: 4px;
				font-size: 12px;
				pointer-events: none;
				z-index: 10000;
			`;
			dragImage.textContent = useSecondaryStyle
				? `${node.label} (${node.className}) [Alt Style]`
				: `${node.label} (${node.className})`;
			document.body.appendChild(dragImage);
			e.dataTransfer.setDragImage(dragImage, 0, 0);

			// Remove drag image after a short delay
			setTimeout(() => {
				document.body.removeChild(dragImage);
			}, 0);
		});

		element.addEventListener("dragend", () => {
			element.classList.remove("dragging");
		});
	}

	/**
	 * Show context menu
	 * @param {MouseEvent} e
	 * @param {any} node
	 */
	function showContextMenu(e, node) {
		contextMenu.innerHTML = "";

		const menuItems = [
			{ label: "Go to Definition", action: "goToDefinition", enabled: true },
			{ label: "Open Documentation", action: "openDocumentation", enabled: true },
			{ separator: true },
			{ label: "Copy Node Path", action: "copyNodePath", enabled: true },
			{ label: "Copy Resource Path", action: "copyResourcePath", enabled: !!node.resourcePath },
			{ separator: true },
			{ label: "Open Scene", action: "openScene", enabled: !!node.resourcePath && node.resourcePath.endsWith(".tscn") },
			{ label: "Open Script", action: "openScript", enabled: node.hasScript },
		];

		for (const item of menuItems) {
			if (item.separator) {
				const sep = document.createElement("div");
				sep.className = "context-menu-separator";
				contextMenu.appendChild(sep);
			} else {
				const menuItem = document.createElement("div");
				menuItem.className = "context-menu-item";
				if (!item.enabled) {
					menuItem.className += " disabled";
				}
				menuItem.textContent = item.label;
				menuItem.addEventListener("click", () => {
					if (item.enabled) {
						vscode.postMessage({
							type: "contextMenu",
							node: node,
							action: item.action,
						});
					}
					hideContextMenu();
				});
				contextMenu.appendChild(menuItem);
			}
		}

		// Position the menu
		const x = e.clientX;
		const y = e.clientY;

		contextMenu.style.left = `${x}px`;
		contextMenu.style.top = `${y}px`;
		contextMenu.classList.add("visible");

		// Adjust if menu goes off screen
		const rect = contextMenu.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			contextMenu.style.left = `${window.innerWidth - rect.width - 4}px`;
		}
		if (rect.bottom > window.innerHeight) {
			contextMenu.style.top = `${window.innerHeight - rect.height - 4}px`;
		}
	}

	/**
	 * Hide context menu
	 */
	function hideContextMenu() {
		contextMenu.classList.remove("visible");
	}

	// ──── Scene Selector Dropdown ────

	/**
	 * Update the dropdown trigger label
	 * @param {string} title
	 * @param {string} fsPath
	 */
	function updateSelectorLabel(title, fsPath) {
		if (title) {
			sceneSelectorLabel.textContent = title;
			sceneSelectorLabel.title = fsPath;
			sceneSelectorLabel.classList.remove("placeholder");
		} else {
			sceneSelectorLabel.textContent = "No scene selected";
			sceneSelectorLabel.title = "";
			sceneSelectorLabel.classList.add("placeholder");
		}
	}

	function openDropdown() {
		dropdownOpen = true;
		dropdownFilter = "";
		dropdownHighlightIndex = -1;
		sceneSelectorDropdown.classList.add("visible");
		sceneSelectorFilter.value = "";
		sceneSelectorFilter.focus();
		renderDropdownList();
	}

	function closeDropdown() {
		dropdownOpen = false;
		sceneSelectorDropdown.classList.remove("visible");
		dropdownHighlightIndex = -1;
	}

	function toggleDropdown() {
		if (dropdownOpen) {
			closeDropdown();
		} else {
			openDropdown();
		}
	}

	/**
	 * Get filtered scene list based on current filter text
	 * @returns {Array<{fsPath: string, displayName: string, resPath: string}>}
	 */
	function getFilteredScenes() {
		if (!dropdownFilter.trim()) {
			return sceneList;
		}
		const lower = dropdownFilter.toLowerCase();
		return sceneList.filter(s =>
			s.displayName.toLowerCase().includes(lower) ||
			s.resPath.toLowerCase().includes(lower)
		);
	}

	/**
	 * Render the dropdown list items
	 */
	function renderDropdownList() {
		sceneSelectorList.innerHTML = "";
		const filtered = getFilteredScenes();

		if (filtered.length === 0) {
			const empty = document.createElement("div");
			empty.className = "scene-selector-empty";
			empty.textContent = dropdownFilter ? "No matching scenes" : "No scenes found";
			sceneSelectorList.appendChild(empty);
			return;
		}

		filtered.forEach((scene, index) => {
			const item = document.createElement("div");
			item.className = "scene-selector-item";
			if (scene.fsPath === currentScenePath) {
				item.classList.add("current");
			}
			if (index === dropdownHighlightIndex) {
				item.classList.add("highlighted");
			}

			const name = document.createElement("span");
			name.className = "scene-selector-item-name";
			name.textContent = scene.displayName;
			item.appendChild(name);

			const resPath = document.createElement("span");
			resPath.className = "scene-selector-item-path";
			resPath.textContent = scene.resPath;
			item.appendChild(resPath);

			item.addEventListener("click", () => {
				selectScene(scene.fsPath);
			});

			sceneSelectorList.appendChild(item);
		});
	}

	/**
	 * Select a scene from the dropdown
	 * @param {string} fsPath
	 */
	function selectScene(fsPath) {
		closeDropdown();
		vscode.postMessage({ type: "selectScene", fsPath });
	}

	/**
	 * Scroll highlighted item into view
	 */
	function scrollHighlightedIntoView() {
		const highlighted = sceneSelectorList.querySelector(".scene-selector-item.highlighted");
		if (highlighted) {
			highlighted.scrollIntoView({ block: "nearest" });
		}
	}

	// Initialize when DOM is ready
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();
