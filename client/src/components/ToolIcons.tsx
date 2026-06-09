import { type SVGProps, type ReactElement } from "react";

export type ToolIconName =
  | "read_file"
  | "read_pdf"
  | "write_file"
  | "edit_file"
  | "list_files"
  | "bash"
  | "run_python"
  | "create_artifact"
  | "save_memory"
  | "search_memory"
  | "ask_user"
  | "web_fetch"
  | "web_search"
  | "search_conversation"
  | "default";

const icons: Record<ToolIconName, (props: SVGProps<SVGSVGElement>) => ReactElement> = {
  read_file: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  ),
  read_pdf: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
      <circle cx="15.5" cy="17" r="3" />
    </svg>
  ),
  write_file: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="12" x2="12" y2="18" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  ),
  edit_file: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  ),
  list_files: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  ),
  bash: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="7 10 11 14 7 18" />
    </svg>
  ),
  run_python: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <g transform="scale(1.5)">
        <path d="M5.79 1.574h3.866c.14 0 .252.11.252.246v5.186a.25.25 0 01-.252.246H6.344c-.975 0-1.766.77-1.766 1.72v1.162a.25.25 0 01-.253.243H1.867a.25.25 0 01-.253-.246V6.177a.25.25 0 01.252-.246H7.98c.418 0 .757-.33.757-.737a.747.747 0 00-.757-.738H5.537V1.82a.25.25 0 01.253-.246zm5.632 2.592V1.82c0-.95-.79-1.72-1.766-1.72H5.79c-.976 0-1.767.77-1.767 1.72v2.636H1.867C.89 4.456.1 5.226.1 6.176v3.955c0 .95.79 1.72 1.766 1.72h2.46c.085 0 .17-.006.252-.017v2.346c0 .95.79 1.72 1.766 1.72h3.866c.976 0 1.767-.77 1.767-1.72v-2.636h2.156c.976 0 1.767-.77 1.767-1.72V5.868c0-.95-.79-1.72-1.767-1.72h-2.458c-.086 0-.17.005-.253.017zm-5.33 5.974V8.994a.25.25 0 01.252-.246h3.312c.976 0 1.766-.77 1.766-1.72V5.866a.25.25 0 01.253-.243h2.458c.14 0 .253.11.253.246v3.954a.25.25 0 01-.252.246H8.02a.747.747 0 00-.757.737c0 .408.339.738.757.738h2.442v2.636a.25.25 0 01-.253.246H6.344a.25.25 0 01-.252-.246v-4.04z" />
      </g>
    </svg>
  ),
  create_artifact: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 8h18" />
      <path d="M8 14h5" />
      <path d="M10.5 11.5v5" />
      <path d="M17 12v4" />
      <path d="M15 14h4" />
    </svg>
  ),
  save_memory: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v10c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
      <path d="M5 10c0 1.7 3.1 3 7 3s7-1.3 7-3" />
      <path d="M5 15c0 1.7 3.1 3 7 3s7-1.3 7-3" />
    </svg>
  ),
  search_memory: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <ellipse cx="10" cy="6" rx="4.5" ry="2" />
      <path d="M5.5 6v5c0 1.1 1.5 2 3.7 2.2" />
      <path d="M14.5 6v3" />
      <path d="M5.5 9c0 1 1.3 1.9 3.1 2.1" />
      <circle cx="15" cy="15" r="4" />
      <path d="m18 18 3 3" />
    </svg>
  ),
  ask_user: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 22V19H8A3 3 0 0 1 4 16V8A2 2 0 0 1 6 6H20A2 2 0 0 1 22 8V16A3 3 0 0 1 20 19H8Z" />
      <path d="M10.75 9.5A1.75 1.75 0 1 1 14.25 11.1C13.4 11.6 13 12.1 13 12.8" />
      <line x1="13" y1="15.5" x2="13.01" y2="15.5" />
    </svg>
  ),
  web_fetch: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3v13" />
      <path d="m7 13 5 5 5-5" />
      <path d="M4 19v2h16v-2" />
    </svg>
  ),
  web_search: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M4 10.5h13" />
      <path d="M10.5 4a10 10 0 0 0 0 13" />
      <path d="M10.5 4a10 10 0 0 1 0 13" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
  ),
  search_conversation: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 22V19H8A3 3 0 0 1 4 16V8A2 2 0 0 1 6 6H20A2 2 0 0 1 22 8V16A3 3 0 0 1 20 19H8Z" />
      <circle cx="13" cy="11" r="2.5" />
      <path d="m14.8 12.8 2.2 2.2" />
    </svg>
  ),
  default: (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  ),
};

export function ToolIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: ToolIconName }) {
  const Component = icons[name];
  return Component ? <Component width={14} height={14} {...props} /> : null;
}
