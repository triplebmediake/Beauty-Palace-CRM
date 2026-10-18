// Single source of truth for what each role may do. scripts/gen-seed.js turns this into db/seed.sql,
// and the server loads the live copy from role_permissions on every request (see authenticate()).
export const PERMISSIONS = {
  'dashboard.view': 'View management dashboard',
  'customers.view': 'View all customers', 'customers.view_assigned': 'View customers assigned to me',
  'customers.manage': 'Create and edit customers', 'appointments.view': 'View all appointments',
  'appointments.view_own': 'View my appointments', 'appointments.manage': 'Create and change appointments',
  'queue.manage': 'Manage the walk-in queue', 'sales.create': 'Ring up sales', 'sales.view': 'View all sales',
  'sales.view_own': 'View my own sales', 'sales.void': 'Void a sale (reason required)', 'receipts.view': 'View and reprint receipts',
  'payments.process': 'Take payments', 'payments.reconcile': 'Reconcile payments',
  'discounts.apply': 'Apply discounts', 'discounts.approve': 'Approve discounts above the limit',
  'services.view': 'View services and prices', 'services.perform': 'Start and complete services',
  'services.manage': 'Manage the service catalogue', 'pricing.manage': 'Change prices',
  'materials.record': 'Record materials used', 'commissions.view_own': 'View my commission',
  'commissions.view_all': 'View all commissions', 'commissions.rules.manage': 'Change commission rules',
  'commissions.approve': 'Approve commissions', 'commissions.pay': 'Mark commissions paid',
  'inventory.view': 'View stock', 'inventory.manage': 'Adjust and purchase stock', 'inventory.valuation': 'View stock value',
  'marketing.view': 'View campaigns', 'marketing.manage': 'Create and send campaigns',
  'reports.view': 'View operational reports', 'reports.financial': 'View financial reports',
  'expenses.view': 'View expenses', 'expenses.manage': 'Record expenses', 'targets.manage': 'Set targets',
  'staff.view': 'View staff', 'staff.manage': 'Manage staff and technicians', 'users.manage': 'Manage users and roles',
  'branches.manage': 'Manage branches', 'settings.manage': 'Change system settings', 'settings.business': 'Change salon name, logo, contact details and hours', 'audit.view': 'View the audit trail',
  'data.export': 'Export data', 'data.import': 'Import data',
};
const ALL = Object.keys(PERMISSIONS);
const without = (list, drop) => list.filter((p) => !drop.includes(p));

export const ROLES = {
  super_admin: { name: 'Super Admin', permissions: ALL },
  // Owner: everything except users, branches and system settings. Owners CAN change prices and commission rules.
  owner: { name: 'Business Owner / Management',
    permissions: without(ALL, ['users.manage', 'branches.manage', 'settings.manage']) },
  manager: { name: 'Salon Manager', permissions: [
    'dashboard.view', 'customers.view', 'customers.manage', 'appointments.view', 'appointments.manage', 'queue.manage',
    'sales.create', 'sales.view', 'sales.void', 'receipts.view', 'payments.process', 'discounts.apply', 'discounts.approve',
    'services.view', 'materials.record', 'commissions.view_all', 'commissions.approve', 'inventory.view', 'inventory.manage',
    'marketing.view', 'marketing.manage', 'reports.view', 'expenses.view', 'staff.view', 'staff.manage', 'data.export'] },
  receptionist: { name: 'Receptionist', permissions: [
    'customers.view', 'customers.manage', 'appointments.view', 'appointments.manage', 'queue.manage', 'sales.create',
    'receipts.view', 'payments.process', 'discounts.apply', 'services.view', 'materials.record'] },
  technician: { name: 'Technician', permissions: [
    'appointments.view_own', 'customers.view_assigned', 'services.view', 'services.perform', 'materials.record',
    'sales.view_own', 'commissions.view_own'] },
  accountant: { name: 'Accountant', permissions: [
    'dashboard.view', 'sales.view', 'receipts.view', 'payments.reconcile', 'expenses.view', 'expenses.manage',
    'commissions.view_all', 'commissions.pay', 'reports.view', 'reports.financial', 'inventory.view', 'inventory.valuation', 'data.export'] },
};

export const can = (permissionSet, perm) => permissionSet.has(perm);

/** Rows a user may see. Technicians are limited to their own technician id. */
export function dataScope(user) {
  const all = user.permissions.has('sales.view') || user.permissions.has('commissions.view_all');
  return all ? { type: 'all' } : { type: 'own', technicianId: user.technicianId ?? -1 };
}
