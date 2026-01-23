
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface EduTooltipProps {
  text: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom';
}

export const EduTooltip: React.FC<EduTooltipProps> = ({ text, children, position = 'top' }) => {
  const [isVisible, setIsVisible] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!isVisible) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const left = rect.left + rect.width / 2;
      const top = position === 'top' ? rect.top - 10 : rect.bottom + 10;
      setCoords({ left, top });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isVisible, position]);

  return (
    <span 
      ref={triggerRef}
      className="inline-flex items-center"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children}
      {isVisible && coords && createPortal(
        <div
          className="fixed z-[9999] px-3 py-2 text-xs font-medium text-white bg-gray-900 rounded-lg shadow-xl max-w-[280px] text-center whitespace-pre-line"
          style={{
            left: coords.left,
            top: coords.top,
            transform: position === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
          }}
        >
          {text}
          <div
            className={`absolute left-1/2 -translate-x-1/2 border-8 ${
              position === 'top'
                ? 'top-full border-transparent border-t-gray-900'
                : 'bottom-full border-transparent border-b-gray-900'
            }`}
          />
        </div>,
        document.body
      )}
    </span>
  );
};
