# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Security
- Improve Python sandbox isolation (#18)

### Added
- Add memory extraction failure metrics and monitoring (#20)
- Track cumulative token usage for pre-compaction flush (#27)
- Batch embeddings during memory extraction (#22)

### Fixed
- Fix chat title truncation for multi-byte characters (#25)
- Improve error handling for fire-and-forget memory extraction (#23)
- Add mutex for memory write operations (#26)
- Fix ThinkingBlock prop-to-state sync pattern (#10)
- Fix SystemPromptEditor prop-to-state sync via useEffect (#7)
- Remove redundant canSend dependency from MessageInput handleSubmit (#9)
- Hoist remarkPlugins array to module scope in MarkdownRenderer (#1)

### Changed
- Add integration tests for tool loop and message conversion (#24)
- Start session for code review improvements (#21)
- Cache Ollama model discovery results (#19)
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
