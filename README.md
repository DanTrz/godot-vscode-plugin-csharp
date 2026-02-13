# Godot Tools C# (Fork)

A fork of [godot-vscode-plugin](https://github.com/godotengine/godot-vscode-plugin) with **C# enhancements** for Godot 4 development.

---

## 🎯 Key Features

### 1. C# Drag & Drop Code Generation

Drag nodes from the **Scene Preview** panel directly into your C# scripts to automatically generate node reference code.

#### How to Use

1. Open a `.tscn` file to see the **Scene Preview** in the sidebar
2. Open your C# script (`.cs` file)
3. **Drag any node** from the Scene Preview into your script
4. Code is automatically generated based on your preferred style

#### Code Styles

| Style | Generated Code |
|-------|----------------|
| **[Export] public** | `[Export] public Button MyButton { get; set; }` |
| **[Export] private** | `[Export] private Button _myButton { get; set; }` |
| **Lazy field (C# 14)** | `Button _myButton => field ??= GetNode<Button>("path");` |
| **Expression-bodied** | `Button MyButton => GetNode<Button>("path");` |

#### Primary & Secondary Styles

- **Normal drag** → Uses your primary style
- **Ctrl + drag** → Uses secondary style (shows "[Alt Style]" in preview)

#### Smart NodePath Auto-Assignment

When using **[Export]** styles (`exportPublic` or `exportPrivate`), the extension does more than just generate C# code — it also updates the `.tscn` scene file to wire up the NodePath automatically.

**What happens on drop:**
1. The C# `[Export]` property is inserted into your script
2. The `.tscn` file is updated with the correct `NodePath` assignment
3. A **"Rebuild C#"** banner appears in the Scene Preview panel

**After dropping:**
1. Click **Rebuild** in the Scene Preview banner (runs `dotnet build`)
IMPORTANT: YOU MUST Rebuild from within VSCode before going back to Godot. 
2. In Godot, click **"Reload from disk"** when prompted

> **Note:** `lazyField` and `expressionBodied` styles use `GetNode<T>()` at runtime, so no scene file modification is needed — they just work.

#### Configuration

Set your preferred styles in VS Code settings:

```
Settings > Godot Tools > C# > Node Reference Style
Settings > Godot Tools > C# > Secondary Node Reference Style
```

Or in `settings.json`:
```json
"godotTools.csharp.nodeReferenceStyle": "exportPublic",
"godotTools.csharp.secondaryNodeReferenceStyle": "lazyField"
```

Options: `exportPublic`, `exportPrivate`, `lazyField`, `expressionBodied`

> **Tip:** When dropping on an empty line, your default style is used automatically. No dialog needed!

---

### 2. Scene Preview Panel

The **Scene Preview** panel gives you a full view of your `.tscn` scene tree directly inside VS Code — no need to switch to Godot.

#### Features

- **Search & Filter** — Type in the search bar to quickly find nodes by name
- **Scene Selector** — Use the dropdown to switch between scenes in your project without opening `.tscn` files manually
- **Instanced Scenes** — Children of instanced scenes are shown recursively, so you can see the full tree
- **Node Badges** — Visual indicators for script-attached nodes, unique names (`%`), and instanced scenes
- **Lock/Unlock** — Lock the panel to a specific scene so it doesn't change when you switch editor tabs
- **Drag to Code** — Drag any node from the Scene Preview directly into your C# or GDScript files (see Drag & Drop above)

#### Auto-Detection

The Scene Preview automatically shows the relevant scene when you're editing:
- A `.tscn` file → shows that scene
- A `.cs` or `.gd` script → finds and shows the matching scene (configurable: same folder, any folder, or off)

Configure in `settings.json`:
```json
"godotTools.scenePreview.previewRelatedScenes": "anyFolder"
```

Options: `anyFolder`, `sameFolder`, `off`

---

### 3. Active Scene Tree for C# Debugging

View the **running scene tree** and **inspect node properties** during C# debugging - features previously only available in the Godot Editor for GDScript.

| Feature | Original Plugin | This Fork |
|---------|-----------------|-----------|
| Active Scene Tree | GDScript only | ✅ **Works with C#** |
| Node Inspector | GDScript only | ✅ **Works with C#** |
| Auto-refresh | GDScript only | ✅ **Works with C#** |
| **Search/Filter** | ❌ | ✅ **New** |

#### Setup for Scene Tree Monitor

**Step 1:** Add `--remote-debug` to your `launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "name": "Play",
            "type": "coreclr",
            "request": "launch",
            "preLaunchTask": "build",
            "program": "${env:GODOT4}",
            "args": [
                "--remote-debug",
                "tcp://127.0.0.1:6007"
            ],
            "cwd": "${workspaceFolder}",
            "stopAtEntry": false
        }
    ]
}
```

**Step 2:** Press F5 to debug. The Scene Tree Monitor auto-starts.

**Step 3:** Click the **eye icon** on any node to inspect its properties.

#### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `godotTools.sceneTreeMonitor.port` | `6007` | Port for Godot connection |
| `godotTools.sceneTreeMonitor.autoStart` | `true` | Auto-start on C# debug |
| `godotTools.sceneTreeMonitor.refreshInterval` | `500` | Refresh interval (ms) |

---

### 4. Live Property Editing on Node Inspector

Right-click any property in the Node Inspector and select "Edit Value" to modify it at runtime.

**Supported types:** `int`, `float`, `bool`, `string`, `Vector2`, `Vector3`, `Vector4`, `Color`, `Transform3D`, and more.

### 5. Advanced Debug Controls

Full debug control panel for C# projects:

| Control | Description |
|---------|-------------|
| **Pause/Resume** | Pause game execution from VS Code |
| **Frame Step** | Advance exactly one frame (when paused) |
| **Live Edit** | Modify node properties at runtime |
| **Inspector Search** | Filter properties by name |

---

### 6. Auto-Rebuild with `dotnet watch`

Enable background auto-rebuilding so Godot picks up C# changes automatically — no manual rebuild step needed.

When enabled, the extension starts `dotnet watch build` in the background. Every time you save a `.cs` file, it rebuilds automatically and Godot detects the updated assembly.

#### Setup

In `settings.json`:
```json
"godotTools.csharp.dotnetWatch": true
```

Or: `Settings > Godot Tools > C# > Dotnet Watch`

> **Tip:** With `dotnet watch` enabled, you can skip clicking "Rebuild" after drag-and-drop — just save your `.cs` file and the rebuild happens automatically.

---

## Installation

### Prerequisites

- **Godot 4.2+** (.NET version)
- **VS Code** with C# extension
- **.NET SDK** installed

### Install from VSIX

1. Download `.vsix` from [Releases](https://github.com/DanTrz/godot-vscode-plugin-csharp/releases)
2. In VS Code: `Ctrl+Shift+P` → "Extensions: Install from VSIX..."
3. Select the downloaded file

---

## Troubleshooting

### Scene Tree not populating?

1. Check `--remote-debug tcp://127.0.0.1:6007` is in your launch.json args
2. Verify port matches `godotTools.sceneTreeMonitor.port` setting
3. Requires Godot 4.2+

### Drag & Drop not working?

1. Make sure you're dragging from **Scene Preview** (not file explorer)
2. Target must be a `.cs` file
3. The Scene Preview panel shows nodes from `.tscn` files

### NodePath not showing in Godot after drag & drop?

1. After dropping a node with an `[Export]` style, click **Rebuild** in the Scene Preview banner
2. In Godot, click **"Reload from disk"** when the dialog appears
3. The order matters: rebuild C# **first**, then reload the scene in Godot
4. If you have `dotnet watch` enabled, just save your `.cs` file and wait for the auto-rebuild before reloading

---

## Original Features

This fork includes all features from [godot-vscode-plugin](https://github.com/godotengine/godot-vscode-plugin):

- GDScript language support
- GDScript debugger
- Scene Preview
- GDShader support
- And more...

---

## Contributing

Issues and PRs welcome at [github.com/DanTrz/godot-vscode-plugin-csharp](https://github.com/DanTrz/godot-vscode-plugin-csharp)

*Based on [godot-vscode-plugin](https://github.com/godotengine/godot-vscode-plugin) by the Godot Engine community*
