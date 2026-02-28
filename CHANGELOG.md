# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

### Fixed
- Fix ThinkingBlock prop-to-state sync pattern (#10)
- Fix SystemPromptEditor prop-to-state sync via useEffect (#7)
- Remove redundant canSend dependency from MessageInput handleSubmit (#9)
- Hoist remarkPlugins array to module scope in MarkdownRenderer (#1)

### Changed
- Add passive flag to RippleGridBackground resize listener (#17)
- Hoist inline SVG icons in ChatView (#15)
- Use Set for isMonospaceOutput lookup in ToolCallDisplay (#16)
- Hoist static objects and SVG JSX in ToolCallDisplay (#14)
- Lazy-import @simplewebauthn/browser on demand (#11)
- Extract inline arrow function props to useCallback in App.tsx (#8)
- Narrow activeChat dependency to boolean in App.tsx callbacks (#12)
- Wrap auto-scroll in requestAnimationFrame (#13)
- Add content-visibility to message list items (#6)
- Lazy-load RippleGridBackground (#5)
- Reduce streaming delta allocation overhead in onDelta (#4)
- Memoize totalUsage computation in useChat (#3)
- Lazy-load MarkdownRenderer via React.lazy (#2)
