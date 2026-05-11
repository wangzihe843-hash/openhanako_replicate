import { useEffect, useState } from 'react';
import type { CSSProperties, ImgHTMLAttributes } from 'react';
import type { Agent } from '../types';
import { hanaUrl } from '../hooks/use-hana-fetch';
import { yuanFallbackAvatar } from '../utils/agent-helpers';

type XingyeAgentAvatarProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  agent: Agent;
  style?: CSSProperties;
};

export function getXingyeAgentAvatarSrc(agent: Agent): string {
  return agent.hasAvatar
    ? hanaUrl(`/api/agents/${agent.id}/avatar?t=0`)
    : yuanFallbackAvatar(agent.yuan);
}

export function XingyeAgentAvatar({
  agent,
  alt = '',
  onError,
  ...imgProps
}: XingyeAgentAvatarProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const avatarSrc = agent.hasAvatar
    ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${refreshKey || 0}`)
    : yuanFallbackAvatar(agent.yuan);

  useEffect(() => {
    const handleAvatarUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ role?: string; agentId?: string | null; at?: number }>).detail;
      if (detail?.role === 'agent' && detail.agentId === agent.id) {
        setRefreshKey(typeof detail.at === 'number' ? detail.at : 0);
      }
    };

    window.addEventListener('hana-avatar-updated', handleAvatarUpdated);
    return () => window.removeEventListener('hana-avatar-updated', handleAvatarUpdated);
  }, [agent.id]);

  return (
    <img
      key={`${agent.id}-${refreshKey}`}
      {...imgProps}
      src={avatarSrc}
      alt={alt}
      draggable={imgProps.draggable ?? false}
      onError={(event) => {
        const img = event.currentTarget;
        img.onerror = null;
        img.src = yuanFallbackAvatar(agent.yuan);
        onError?.(event);
      }}
    />
  );
}
