# commit-org

A simple Electron-based Git commit organizer for rearranging and editing commits.

## Features

- **Open Git Projects**: Easily open any Git repository directory
- **Visual File Tree**: View changed files in a hierarchical tree structure with collapsible folders
- **Selective Staging**: Select entire files or individual hunks for committing
- **Custom Commit Dates**: Set custom dates and times for commits
- **Commit History**: Browse commit history with reset options
- **Upstream Tracking**: View and reset to upstream branches
- **Cross-Platform**: Works on macOS, Windows, and Linux

## Installation

### Prerequisites

- Node.js 20 or later
- Git

### Install Dependencies

```bash
npm install
```

### Development

```bash
npm run dev
```

### Build

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# General build
npm run build
```

## Usage

1. Launch the application
2. Click "Open Project" and select a Git repository directory
3. View changed files in the left sidebar (organized in a tree)
4. Select files or hunks to include in your commit
5. Enter a commit message and optionally set a custom date/time
6. Click "Commit" to create the commit
7. Use the "History" tab to view past commits and reset if needed

### File Selection

- **Folders**: Click folder names to expand/collapse
- **Files**: Click checkboxes to select/deselect entire files
- **Hunks**: In the diff view, select individual code hunks for partial commits

### Reset Options

- **Soft Reset**: Keeps changes staged
- **Mixed Reset**: Unstages changes but keeps them in working directory
- **Hard Reset**: Discards all changes

## Disclaimer

This tool is designed for commit rearrangement. Always switch to the correct branch before using, and perform push operations in your regular VCS tools after organizing commits.

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## License

See LICENSE file for details.

## Author

Made with ♥ by [mujdecisy](https://mujdecisy.github.io)