import { useState, useEffect, useRef, useCallback } from "react";
import type { SkillInfo } from "../api/client";

interface Props {
  skills: SkillInfo[];
  filterText: string;
  onSelect: (skillName: string) => void;
  onClose: () => void;
  inputRect: DOMRect | null;
}

export function SkillSelector({ skills, filterText, onSelect, onClose, inputRect }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const filteredSkills = skills.filter(s => 
    s.name.toLowerCase().includes(filterText.toLowerCase())
  );
  
  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [filterText]);
  
  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);
  
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filteredSkills.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (filteredSkills.length > 0) {
        e.preventDefault();
        onSelect(filteredSkills[selectedIndex].name);
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  }, [filteredSkills, selectedIndex, onSelect, onClose]);
  
  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
  
  if (filteredSkills.length === 0 || !inputRect) return null;
  
  // Position the selector above or below the input
  const viewportHeight = window.innerHeight;
  const spaceBelow = viewportHeight - inputRect.bottom;
  const positionAbove = spaceBelow < 200 && inputRect.top > 200;
  
  const style: React.CSSProperties = {
    position: "fixed",
    left: inputRect.left,
    top: positionAbove ? inputRect.top - 200 : inputRect.bottom,
    minWidth: 250,
    maxWidth: "calc(100vw - 32px)",
    width: "fit-content",
    maxHeight: 200,
    overflowY: "auto",
    zIndex: 1000,
    backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
    border: "1px solid rgba(var(--theme-primary-border), 0.5)",
    borderRadius: "12px",
    boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  };
  
  return (
    <div ref={containerRef} style={style} className="skill-selector">
      {filteredSkills.map((skill, i) => (
        <button
          key={skill.name}
          className={`skill-item ${i === selectedIndex ? "selected" : ""}`}
          onClick={() => onSelect(skill.name)}
          style={{
            display: "block",
            width: "100%",
            padding: "10px 14px",
            textAlign: "left",
            background: i === selectedIndex ? `rgba(var(--theme-secondary), 0.15)` : "transparent",
            border: "none",
            borderBottom: "1px solid rgba(255,255,255,0.05)",
            color: i === selectedIndex ? "white" : "rgba(255,255,255,0.7)",
            cursor: "pointer",
            fontSize: "13px",
          }}
        >
          <div style={{ fontWeight: 500, color: i === selectedIndex ? "white" : "rgba(255,255,255,0.9)" }}>
            /{skill.name}
          </div>
          {skill.description && (
            <div style={{ 
              fontSize: "11px", 
              color: "rgba(255,255,255,0.4)",
              marginTop: "2px",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}>
              {skill.description}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
