'use client';
import { forwardRef } from 'react';
import { navigate } from './router';

type Props = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; replace?: boolean };

const Link = forwardRef<HTMLAnchorElement, Props>(function Link({ href, onClick, prefetch: _p, replace, ...rest }, ref) {
  return (
    <a ref={ref} href={`#${href.replace(/^\//, '') || 'overview'}`} {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || href.startsWith('http')) return;
        e.preventDefault();
        navigate(href, replace);
      }} />
  );
});
export default Link;
