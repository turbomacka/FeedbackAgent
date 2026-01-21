
import React, { useState } from 'react';

interface EduTooltipProps {
  text: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom';
}

export const EduTooltip: React.FC<EduTooltipProps> = ({ text, children, position = 'top' }) => {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div 
      className="relative inline-block"
      onMouseEnter={() => setIsVisible(true)}
      onMouseLeave={() => setIsVisible(false)}
    >
      {children}
      {isVisible && (
        <div className={`
          absolute z-50 px-3 py-2 text-xs font-medium text-white bg-gray-900 rounded-lg shadow-sm 
          w-48 text-center transition-opacity duration-300
          ${position === 'top' ? 'bottom-full left-1/2 -translate-x-1/2 mb-2' : 'top-full left-1/2 -translate-x-1/2 mt-2'}
        `}>
          {text}
          <div className={`
            absolute left-1/2 -translate-x-1/2 border-8
            ${position === 'top' 
              ? 'top-full border-transparent border-t-gray-900' 
              : 'bottom-full border-transparent border-b-gray-900'}
          `} />
        </div>
      )}
    </div>
  );
};
