import React from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

// Route configuration for breadcrumb display names
const routeConfig = {
  '/': { name: 'Dashboard', icon: 'home' },
  '/equipment': { name: 'Equipment', icon: 'equipment' },
  '/zones': { name: 'Zones', icon: 'zones' },
  '/automations': { name: 'Automations', icon: 'automations' },
  '/alerts': { name: 'Alerts', icon: 'alerts' },
  '/settings': { name: 'Settings', icon: 'settings' },
};

// Settings sub-routes
const settingsSubRoutes = {
  '/settings/profile': { name: 'Profile' },
  '/settings/users': { name: 'Users' },
  '/settings/system': { name: 'System' },
  '/settings/cloud': { name: 'Cloud' },
  '/settings/backup': { name: 'Backup' },
};

// Icon component for breadcrumb home icon
function HomeIcon() {
  return (
    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
      <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
    </svg>
  );
}

// Chevron separator icon
function ChevronIcon() {
  return (
    <svg className="h-5 w-5 text-gray-400" fill="currentColor" viewBox="0 0 20 20">
      <path
        fillRule="evenodd"
        d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function useBreadcrumbContext() {
  const [customSegment, setCustomSegment] = React.useState(null);
  return { customSegment, setCustomSegment };
}

// Context for setting custom breadcrumb segments
export const BreadcrumbContext = React.createContext({
  customSegment: null,
  setCustomSegment: () => {},
});

export function BreadcrumbProvider({ children }) {
  const [customSegment, setCustomSegment] = React.useState(null);

  const value = React.useMemo(() => ({
    customSegment,
    setCustomSegment,
  }), [customSegment]);

  return (
    <BreadcrumbContext.Provider value={value}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumb() {
  return React.useContext(BreadcrumbContext);
}

export default function Breadcrumb() {
  const location = useLocation();
  const params = useParams();
  const { customSegment } = useBreadcrumb();

  // Build breadcrumb segments
  const buildBreadcrumbs = () => {
    const crumbs = [];
    const pathname = location.pathname;

    // Always start with Dashboard
    crumbs.push({
      name: 'Dashboard',
      path: '/',
      isHome: true,
      isCurrent: pathname === '/',
    });

    // If we're on the dashboard, just return the home crumb
    if (pathname === '/') {
      return crumbs;
    }

    // Split path into segments
    const segments = pathname.split('/').filter(Boolean);

    if (segments.length === 0) {
      return crumbs;
    }

    // Build path progressively
    let currentPath = '';

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      currentPath += `/${segment}`;

      const isLast = i === segments.length - 1;
      const isId = !isNaN(parseInt(segment, 10));

      // Handle settings sub-routes
      if (segments[0] === 'settings' && i === 0) {
        crumbs.push({
          name: 'Settings',
          path: '/settings',
          isCurrent: pathname === '/settings',
        });
        continue;
      }

      // Handle settings sub-routes
      if (segments[0] === 'settings' && i === 1) {
        const subRoute = settingsSubRoutes[currentPath];
        if (subRoute) {
          crumbs.push({
            name: subRoute.name,
            path: currentPath,
            isCurrent: isLast,
          });
        }
        continue;
      }

      // Handle ID segments (e.g., /equipment/123)
      if (isId) {
        // Use custom segment name if provided (e.g., equipment name)
        if (customSegment && isLast) {
          crumbs.push({
            name: customSegment,
            path: currentPath,
            isCurrent: true,
          });
        }
        continue;
      }

      // Handle regular routes
      const routeInfo = routeConfig[currentPath];
      if (routeInfo) {
        crumbs.push({
          name: routeInfo.name,
          path: currentPath,
          isCurrent: isLast && !params.id,
        });
      }
    }

    return crumbs;
  };

  const breadcrumbs = buildBreadcrumbs();

  // Don't show breadcrumbs if only dashboard
  if (breadcrumbs.length <= 1) {
    return null;
  }

  return (
    <nav className="flex" aria-label="Breadcrumb">
      <ol className="flex items-center space-x-1">
        {breadcrumbs.map((crumb, index) => (
          <li key={crumb.path} className="flex items-center">
            {index > 0 && <ChevronIcon />}
            <div className={`flex items-center ${index > 0 ? 'ml-1' : ''}`}>
              {crumb.isCurrent ? (
                <span
                  className="text-sm font-medium text-gray-500 truncate max-w-[200px]"
                  aria-current="page"
                  title={crumb.name}
                >
                  {crumb.isHome ? <HomeIcon /> : crumb.name}
                </span>
              ) : (
                <Link
                  to={crumb.path}
                  className="text-sm font-medium text-primary-600 hover:text-primary-800 hover:underline flex items-center focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 rounded"
                  title={crumb.name}
                >
                  {crumb.isHome ? <HomeIcon /> : crumb.name}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}
