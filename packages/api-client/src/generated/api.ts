export interface paths {
    "/api/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getHealth"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/health/ready": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getHealthReady"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthRegister"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthRefresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patchAuthPassword"];
        trace?: never;
    };
    "/api/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthLogout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/browser/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthBrowserRegister"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/browser/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthBrowserLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/browser/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthBrowserRefresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/auth/browser/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAuthBrowserLogout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAdminAuthLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminAuthMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/auth/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAdminAuthPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAdminAuthLogout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/permission-catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminPermissionCatalog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/groups": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminGroups"];
        put?: never;
        post: operations["postAdminGroups"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/groups/{group_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteAdminGroupsByGroupId"];
        options?: never;
        head?: never;
        patch: operations["patchAdminGroupsByGroupId"];
        trace?: never;
    };
    "/api/v1/admin/groups/{group_id}/permissions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putAdminGroupsByGroupIdPermissions"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/groups/{group_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminGroupsByGroupIdMembers"];
        put?: never;
        post: operations["postAdminGroupsByGroupIdMembers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/groups/{group_id}/candidates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminGroupsByGroupIdCandidates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/identity-types": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminIdentityTypes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/accounts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminAccounts"];
        put?: never;
        post: operations["postAdminAccounts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/accounts/{admin_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteAdminAccountsByAdminId"];
        options?: never;
        head?: never;
        patch: operations["patchAdminAccountsByAdminId"];
        trace?: never;
    };
    "/api/v1/admin/accounts/{admin_id}/identity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putAdminAccountsByAdminIdIdentity"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/accounts/{admin_id}/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAdminAccountsByAdminIdResetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/phone": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putAdminUsersByUserIdPhone"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/reset-password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAdminUsersByUserIdResetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/avatar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminUsersByUserIdAvatar"];
        put: operations["putAdminUsersByUserIdAvatar"];
        post?: never;
        delete: operations["deleteAdminUsersByUserIdAvatar"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminUsersByUserId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminUsersByUserIdDevices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/disable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patchAdminUsersByUserIdDisable"];
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/enable": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patchAdminUsersByUserIdEnable"];
        trace?: never;
    };
    "/api/v1/admin/users/{user_id}/devices/{device_id}/revoke": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAdminUsersByUserIdDevicesByDeviceIdRevoke"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/audit-actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminAuditActions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/audit-logs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminAuditLogs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/banners": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAppBanners"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/banners": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listAdminBanners"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/banners/{slot}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["updateAdminBanner"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/banners/media": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["uploadAdminBannerImage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/banners/media/{media_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAppBannerImage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/banners/media/{media_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminBannerImage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/analytics/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAnalyticsEvents"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/analytics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminAnalytics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/analytics/details": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminAnalyticsDetails"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/analytics/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminAnalyticsCatalog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/analytics/funnel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postAdminAnalyticsFunnel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/profile/avatar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: operations["putProfileAvatar"];
        post?: never;
        delete: operations["deleteProfileAvatar"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/profile/avatar/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getProfileAvatarByUserId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/profile/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getProfileMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patchProfileMe"];
        trace?: never;
    };
    "/api/v1/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getDevices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/devices/{device_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteDevicesByDeviceId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/exchange-rate-overrides": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getExchangeRateOverrides"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/exchange-rates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getExchangeRates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgers"];
        put?: never;
        post: operations["postLedgers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerId"];
        put?: never;
        post?: never;
        delete: operations["deleteLedgersByLedgerId"];
        options?: never;
        head?: never;
        patch: operations["patchLedgersByLedgerId"];
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/action-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdActionPreview"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/clear": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdClear"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/change-currency": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdChangeCurrency"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/categories": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdCategories"];
        put?: never;
        post: operations["postLedgersByLedgerIdCategories"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/categories/{category_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteLedgersByLedgerIdCategoriesByCategoryId"];
        options?: never;
        head?: never;
        patch: operations["patchLedgersByLedgerIdCategoriesByCategoryId"];
        trace?: never;
    };
    "/api/v1/category-conflicts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getCategoryConflicts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/category-conflicts/{conflict_id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postCategoryConflictsByConflictIdResolve"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/categories/add-batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdCategoriesAddBatch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/categories/reorder": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdCategoriesReorder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/categories/removal-preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdCategoriesRemovalPreview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/categories/remove": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdCategoriesRemove"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/transactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdTransactions"];
        put?: never;
        post: operations["postLedgersByLedgerIdTransactions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/transactions/{transaction_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteLedgersByLedgerIdTransactionsByTransactionId"];
        options?: never;
        head?: never;
        patch: operations["patchLedgersByLedgerIdTransactionsByTransactionId"];
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/recurring-transactions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdRecurringTransactions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/recurring-transactions/generate-due": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdRecurringTransactionsGenerateDue"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/transaction-stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdTransactionStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/aa-stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdAaStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/member-stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdMemberStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/shared-resources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdSharedResources"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdMembers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/members/{member_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteLedgersByLedgerIdMembersByMemberId"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/leave": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdLeave"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/invites": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdInvites"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/invites/{code}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getInvitesByCode"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/invites/{code}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postInvitesByCodeAccept"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/participants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getLedgersByLedgerIdParticipants"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memo-books/{memo_book_id}/entries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getMemoBooksByMemoBookIdEntries"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/day-books/{day_book_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getDayBooksByDayBookIdEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/memo-books/{memo_book_id}/calendar-counts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getMemoBooksByMemoBookIdCalendarCounts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdTemplates"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdPlans"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/workouts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdWorkouts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/preferences": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdPreferences"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/push": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postSyncPush"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/fitness-spaces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncFitnessSpaces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/fitness-spaces/full": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncFitnessSpacesFull"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/pull": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncPull"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/full": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncFull"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/memo-books": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncMemoBooks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/memo-books/full": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncMemoBooksFull"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/day-books": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncDayBooks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/day-books/full": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncDayBooksFull"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/sync/accounting/full": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getSyncAccountingFull"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness/library": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessLibrary"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/taxonomies/{kind}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listOfficialFitnessTaxonomies"];
        put?: never;
        post: operations["createOfficialFitnessTaxonomy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/taxonomies/{kind}/{taxon_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["deleteOfficialFitnessTaxonomy"];
        options?: never;
        head?: never;
        patch: operations["updateOfficialFitnessTaxonomy"];
        trace?: never;
    };
    "/api/v1/admin/fitness/references": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listOfficialFitnessReferences"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/exercises": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listOfficialExercises"];
        put?: never;
        post: operations["postAdminFitnessExercises"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/exercises/{content_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patchAdminFitnessExercisesByContentId"];
        trace?: never;
    };
    "/api/v1/admin/fitness/templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listOfficialTemplates"];
        put?: never;
        post: operations["postAdminFitnessTemplates"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/templates/{content_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patchAdminFitnessTemplatesByContentId"];
        trace?: never;
    };
    "/api/v1/admin/fitness/plans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["listOfficialPlans"];
        put?: never;
        post: operations["postAdminFitnessPlans"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/plans/{content_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["patchAdminFitnessPlansByContentId"];
        trace?: never;
    };
    "/api/v1/fitness/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessCatalog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/media": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["uploadOfficialFitnessMedia"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness/media/{media_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessMediaByMediaId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/admin/fitness/media/{media_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getAdminFitnessMediaByMediaId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/plans/{plan_id}/command": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postFitnessSpacesByFitnessSpaceIdPlansByPlanIdCommand"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/statistics": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdStatistics"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/calendar": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdCalendar"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/workouts/{workout_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdWorkoutsByWorkoutId"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["getFitnessSpacesByFitnessSpaceIdExport"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/fitness-spaces/{fitness_space_id}/import": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postFitnessSpacesByFitnessSpaceIdImport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ledgers/{ledger_id}/imports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postLedgersByLedgerIdImports"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/ws/ticket": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["postWsTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            code: string;
            message: string;
            request_id: string;
            details?: unknown;
        };
        Ledger: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            owner_id?: string;
            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
            sync_id: string;
            name: string;
            currency: string;
            month_start_day: number;
            aa_enabled: boolean;
            archived_at: string | null;
            archive_updated_at: string | null;
            archive_device_id: string | null;
            role: "owner" | "editor";
            member_count: number;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
        };
        TransactionSplit: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            member_id: string;
            amount: string;
        };
        Transaction: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            ledger_id: string;
            /** @enum {string} */
            tx_type: "expense";
            amount: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            happened_at: string;
            note: string | null;
            category_id: string | null;
            category_name: string | null;
            category_kind: "expense" | null;
            currency_code: string;
            native_amount: string;
            recurring_id: string | null;
            occurrence_date: string | null;
            created_by_member_id: string | null;
            last_edited_by_member_id: string | null;
            payer_member_id: string | null;
            aa_mode: "0" | "1" | "2" | null;
            splits: components["schemas"]["TransactionSplit"][];
            revision: number;
            last_edited_at: string | null;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            created_at: string;
        };
        Member: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            ledger_id: string;
            display_name: string;
            member_type: "REGISTERED" | "PLACEHOLDER";
            status: "ACTIVE" | "LEFT" | "REMOVED";
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
        };
        Category: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            owner_id?: string;
            name: string;
            /** @enum {string} */
            kind: "expense";
            level: 1 | 2;
            sort_order: number;
            icon: string | null;
            parent_id: string | null;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
            deleted_at: string | null;
            version_token: string;
        };
        CategoryConflict: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            category_id: string;
            template_key: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            source_device_id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            source_mutation_id: string;
            candidate_version: number;
            action: "upsert" | "delete";
            local_payload: {
                name: string;
                /** @enum {string} */
                kind: "expense";
                level: 1 | 2;
                sort_order: number;
                icon: string | null;
                parent_id: string | null;
            } | null;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            local_updated_at: string;
            cloud_snapshot: components["schemas"]["Category"];
            status: "pending" | "resolved";
            resolution: "cloud" | "local" | null;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            created_at: string;
            resolved_at: string | null;
        };
        CategoryResolution: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            conflict_id: string;
            candidate_version: number;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            source_device_id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            source_mutation_id: string;
            resolution: "cloud" | "local";
            category_state: components["schemas"]["Category"];
        };
        RecurringTransaction: {
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            ledger_id: string;
            /** @enum {string} */
            tx_type: "expense";
            amount: string;
            currency_code: string;
            category_id: string | null;
            note: string | null;
            frequency: "daily" | "weekly" | "monthly" | "yearly";
            interval: number;
            day_of_month: number | null;
            day_of_week: number | null;
            month_of_year: number | null;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            start_date: string;
            end_date: string | null;
            last_generated_date: string | null;
            /** @enum {number} */
            protocol_version: 1;
            time_zone: string;
            enabled: boolean;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
        };
        ExchangeRateOverride: {
            /** @example 1527ffc3-6087-5b6b-99c6-c6837a5db1b6 */
            id: string;
            base_currency: string;
            quote_currency: string;
            rate: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
        };
        DayOriginalDate: {
            calendar_type: "solar" | "lunar";
            original_year: number;
            original_month: number;
            original_day: number;
            is_leap_month: boolean;
            solar_date: string;
        };
        DayBook: {
            name: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            created_at: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
            sync_id: string;
            revision: number;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
            deleted_at: string | null;
        };
        DayEvent: {
            name: string;
            category: "birthday" | "anniversary" | "countdown" | "stage";
            countdown_mode: "fixed_date" | "interval_days" | null;
            interval_days: number | null;
            repeat_type: "none" | "yearly";
            statistic_type: "year" | "day";
            event: {
                calendar_type: "solar" | "lunar";
                original_year: number;
                original_month: number;
                original_day: number;
                is_leap_month: boolean;
                solar_date: string;
            } | null;
            start: {
                calendar_type: "solar" | "lunar";
                original_year: number;
                original_month: number;
                original_day: number;
                is_leap_month: boolean;
                solar_date: string;
            } | null;
            end: {
                calendar_type: "solar" | "lunar";
                original_year: number;
                original_month: number;
                original_day: number;
                is_leap_month: boolean;
                solar_date: string;
            } | null;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            created_at: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
            sync_id: string;
            revision: number;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
            deleted_at: string | null;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            day_book_id: string;
        };
        MemoBook: {
            name: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            created_at: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
            restore?: boolean;
            expected_full_cursor?: string;
            type: "normal" | "credentials";
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
            sync_id: string;
            revision: number;
            deleted_at: string | null;
        };
        MemoEntry: {
            book_type: "normal" | "credentials";
            title: string;
            body_format: "delta_v1" | "fields_v1" | null;
            body: {
                [key: string]: unknown;
            } | null;
            order_key: string | null;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            created_at: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            updated_at: string;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            id: string;
            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
            sync_id: string;
            revision: number;
            deleted_at: string | null;
            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
            memo_book_id: string;
            /**
             * Format: date-time
             * @example 2026-08-20T09:00:00.000Z
             */
            book_updated_at: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getHealth: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                        request_id: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getHealthReady: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                        request_id: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        status: string;
                        request_id: string;
                    };
                };
            };
        };
    };
    postAuthRegister: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    country_code: string;
                    phone: string;
                    password: string;
                    device: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        installation_id: string;
                        name: string;
                        platform: string;
                        app_version?: string;
                        os_version?: string;
                        device_model?: string;
                    };
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        access_token: string;
                        refresh_token: string;
                        /** @enum {string} */
                        token_type: "Bearer";
                        expires_in: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        device_id: string;
                        scopes: string[];
                        user: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            user_id: string;
                            sesame_number: string;
                            display_name: string | null;
                            avatar_url: string | null;
                            avatar_version: number;
                            phone: string;
                            gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAuthLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    country_code: string;
                    phone: string;
                    password: string;
                    device: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        installation_id: string;
                        name: string;
                        platform: string;
                        app_version?: string;
                        os_version?: string;
                        device_model?: string;
                    };
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        access_token: string;
                        refresh_token: string;
                        /** @enum {string} */
                        token_type: "Bearer";
                        expires_in: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        device_id: string;
                        scopes: string[];
                        user: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            user_id: string;
                            sesame_number: string;
                            display_name: string | null;
                            avatar_url: string | null;
                            avatar_version: number;
                            phone: string;
                            gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAuthRefresh: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    refresh_token: string;
                    device?: unknown;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        access_token: string;
                        refresh_token: string;
                        /** @enum {string} */
                        token_type: "Bearer";
                        expires_in: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        device_id: string;
                        scopes: string[];
                        user: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            user_id: string;
                            sesame_number: string;
                            display_name: string | null;
                            avatar_url: string | null;
                            avatar_version: number;
                            phone: string;
                            gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAuthPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    current_password: string;
                    new_password: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAuthLogout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    refresh_token: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAuthBrowserRegister: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    country_code: string;
                    phone: string;
                    password: string;
                    device: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        installation_id: string;
                        name: string;
                        platform: string;
                        app_version?: string;
                        os_version?: string;
                        device_model?: string;
                    };
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        access_token: string;
                        /** @enum {string} */
                        token_type: "Bearer";
                        expires_in: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        device_id: string;
                        scopes: string[];
                        user: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            user_id: string;
                            sesame_number: string;
                            display_name: string | null;
                            avatar_url: string | null;
                            avatar_version: number;
                            phone: string;
                            gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAuthBrowserLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    country_code: string;
                    phone: string;
                    password: string;
                    device: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        installation_id: string;
                        name: string;
                        platform: string;
                        app_version?: string;
                        os_version?: string;
                        device_model?: string;
                    };
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        access_token: string;
                        /** @enum {string} */
                        token_type: "Bearer";
                        expires_in: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        device_id: string;
                        scopes: string[];
                        user: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            user_id: string;
                            sesame_number: string;
                            display_name: string | null;
                            avatar_url: string | null;
                            avatar_version: number;
                            phone: string;
                            gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAuthBrowserRefresh: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    device?: unknown;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        access_token: string;
                        /** @enum {string} */
                        token_type: "Bearer";
                        expires_in: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        device_id: string;
                        scopes: string[];
                        user: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            user_id: string;
                            sesame_number: string;
                            display_name: string | null;
                            avatar_url: string | null;
                            avatar_version: number;
                            phone: string;
                            gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAuthBrowserLogout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": Record<string, never>;
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminAuthLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    username: string;
                    password: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        admin: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            username: string;
                            email: string | null;
                            phone: string | null;
                            display_name: string;
                            identity_type: "super_admin" | "standard_user";
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            group_id: string;
                            group: {
                                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                                id: string;
                                name: string;
                                is_enabled: boolean;
                                is_default: boolean;
                                version: number;
                            };
                            is_enabled: boolean;
                            permissions: string[];
                            allowed_pages: string[];
                            authorization_version: string;
                        };
                        /** Format: date-time */
                        expires_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminAuthMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        admin: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            username: string;
                            email: string | null;
                            phone: string | null;
                            display_name: string;
                            identity_type: "super_admin" | "standard_user";
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            group_id: string;
                            group: {
                                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                                id: string;
                                name: string;
                                is_enabled: boolean;
                                is_default: boolean;
                                version: number;
                            };
                            is_enabled: boolean;
                            permissions: string[];
                            allowed_pages: string[];
                            authorization_version: string;
                        };
                        /** Format: date-time */
                        expires_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminAuthPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    old_password: string;
                    new_password: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminAuthLogout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminPermissionCatalog: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        permissions: {
                            id: string;
                            label: string;
                            dependencies: string[];
                        }[];
                        pages: {
                            id: string;
                            label: string;
                            path: string;
                            required_permissions: string[];
                            assignable: boolean;
                        }[];
                        identities: {
                            value: string;
                            label: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminGroups: {
        parameters: {
            query?: {
                page?: number;
                page_size?: 10 | 20 | 50 | 100;
                q?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            is_default: boolean;
                            name: string;
                            description: string;
                            sort: number;
                            is_enabled: boolean;
                            permissions: string[];
                            page_ids: string[];
                            version: number;
                            member_count: number;
                            created_by: string | null;
                            updated_by: string | null;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminGroups: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: string;
                    description?: string;
                    sort?: number;
                    is_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        id: string;
                        is_default: boolean;
                        name: string;
                        description: string;
                        sort: number;
                        is_enabled: boolean;
                        permissions: string[];
                        page_ids: string[];
                        version: number;
                        member_count: number;
                        created_by: string | null;
                        updated_by: string | null;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteAdminGroupsByGroupId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                group_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAdminGroupsByGroupId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                group_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    name?: string;
                    description?: string;
                    sort?: number;
                    is_enabled?: boolean;
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        id: string;
                        is_default: boolean;
                        name: string;
                        description: string;
                        sort: number;
                        is_enabled: boolean;
                        permissions: string[];
                        page_ids: string[];
                        version: number;
                        member_count: number;
                        created_by: string | null;
                        updated_by: string | null;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    putAdminGroupsByGroupIdPermissions: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                group_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    permissions: string[];
                    page_ids: string[];
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        id: string;
                        is_default: boolean;
                        name: string;
                        description: string;
                        sort: number;
                        is_enabled: boolean;
                        permissions: string[];
                        page_ids: string[];
                        version: number;
                        member_count: number;
                        created_by: string | null;
                        updated_by: string | null;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminGroupsByGroupIdMembers: {
        parameters: {
            query?: {
                page?: number;
                page_size?: 10 | 20 | 50 | 100;
                q?: string;
            };
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                group_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            username: string;
                            email: string | null;
                            phone: string | null;
                            display_name: string;
                            identity_type: "super_admin" | "standard_user";
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            group_id: string;
                            group: {
                                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                                id: string;
                                name: string;
                                is_enabled: boolean;
                                is_default: boolean;
                                version: number;
                            };
                            is_enabled: boolean;
                            version: number;
                            last_login_at: string | null;
                            created_by: string | null;
                            updated_by: string | null;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminGroupsByGroupIdMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                group_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    members: {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        admin_id: string;
                        version: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        group_id: string;
                        group_version: number;
                    }[];
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        transferred: number;
                        self_session_revoked: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminGroupsByGroupIdCandidates: {
        parameters: {
            query?: {
                page?: number;
                page_size?: 10 | 20 | 50 | 100;
                q?: string;
            };
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                group_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            username: string;
                            email: string | null;
                            phone: string | null;
                            display_name: string;
                            identity_type: "super_admin" | "standard_user";
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            group_id: string;
                            group: {
                                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                                id: string;
                                name: string;
                                is_enabled: boolean;
                                is_default: boolean;
                                version: number;
                            };
                            is_enabled: boolean;
                            version: number;
                            last_login_at: string | null;
                            created_by: string | null;
                            updated_by: string | null;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminIdentityTypes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            value: "super_admin" | "standard_user";
                            label: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminAccounts: {
        parameters: {
            query?: {
                page?: number;
                page_size?: 10 | 20 | 50 | 100;
                q?: string;
                identity_type?: "super_admin" | "standard_user";
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                group_id?: string;
                is_enabled?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            username: string;
                            email: string | null;
                            phone: string | null;
                            display_name: string;
                            identity_type: "super_admin" | "standard_user";
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            group_id: string;
                            group: {
                                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                                id: string;
                                name: string;
                                is_enabled: boolean;
                                is_default: boolean;
                                version: number;
                            };
                            is_enabled: boolean;
                            version: number;
                            last_login_at: string | null;
                            created_by: string | null;
                            updated_by: string | null;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminAccounts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    username: string;
                    password: string;
                    display_name: string;
                    email?: string | null;
                    phone?: string | null;
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    group_id?: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        id: string;
                        username: string;
                        email: string | null;
                        phone: string | null;
                        display_name: string;
                        identity_type: "super_admin" | "standard_user";
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        group_id: string;
                        group: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            name: string;
                            is_enabled: boolean;
                            is_default: boolean;
                            version: number;
                        };
                        is_enabled: boolean;
                        version: number;
                        last_login_at: string | null;
                        created_by: string | null;
                        updated_by: string | null;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteAdminAccountsByAdminId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                admin_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAdminAccountsByAdminId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                admin_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    display_name?: string;
                    email?: string | null;
                    phone?: string | null;
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    group_id?: string;
                    is_enabled?: boolean;
                    reason?: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        id: string;
                        username: string;
                        email: string | null;
                        phone: string | null;
                        display_name: string;
                        identity_type: "super_admin" | "standard_user";
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        group_id: string;
                        group: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            name: string;
                            is_enabled: boolean;
                            is_default: boolean;
                            version: number;
                        };
                        is_enabled: boolean;
                        version: number;
                        last_login_at: string | null;
                        created_by: string | null;
                        updated_by: string | null;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    putAdminAccountsByAdminIdIdentity: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                admin_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    identity_type: "super_admin" | "standard_user";
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        id: string;
                        username: string;
                        email: string | null;
                        phone: string | null;
                        display_name: string;
                        identity_type: "super_admin" | "standard_user";
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        group_id: string;
                        group: {
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            id: string;
                            name: string;
                            is_enabled: boolean;
                            is_default: boolean;
                            version: number;
                        };
                        is_enabled: boolean;
                        version: number;
                        last_login_at: string | null;
                        created_by: string | null;
                        updated_by: string | null;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminAccountsByAdminIdResetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                admin_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    new_password: string;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    putAdminUsersByUserIdPhone: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    country_code: string;
                    phone: string;
                    current_phone: string;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminUsersByUserIdResetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    new_password: string;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminUsersByUserIdAvatar: {
        parameters: {
            query?: {
                v?: number;
            };
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/png": string;
                    "image/jpeg": string;
                    "image/webp": string;
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    putAdminUsersByUserIdAvatar: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content_type: "image/png" | "image/jpeg" | "image/webp";
                    data_base64: string;
                    avatar_version: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        avatar_url: string;
                        avatar_version: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteAdminUsersByUserIdAvatar: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    avatar_version: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminUsers: {
        parameters: {
            query?: {
                page?: number;
                page_size?: 10 | 20 | 50 | 100;
                search?: string;
                is_enabled?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            phone: string;
                            phone_masked: string | null;
                            sesame_number: string | null;
                            display_name: string | null;
                            gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                            avatar_url: string | null;
                            avatar_version: number;
                            is_enabled: boolean;
                            /** Format: date-time */
                            created_at: string;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminUsersByUserId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        phone: string;
                        phone_masked: string | null;
                        sesame_number: string | null;
                        display_name: string | null;
                        gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        avatar_url: string | null;
                        avatar_version: number;
                        is_enabled: boolean;
                        /** Format: date-time */
                        created_at: string;
                        profile_updated_at: string | null;
                        primary_currency: string | null;
                        theme_primary_color: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminUsersByUserIdDevices: {
        parameters: {
            query?: {
                page?: number;
                page_size?: 10 | 20 | 50 | 100;
            };
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            name: string;
                            platform: string;
                            app_version: string | null;
                            os_version: string | null;
                            device_model: string | null;
                            last_ip: string | null;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            last_seen_at: string;
                            revoked_at: string | null;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAdminUsersByUserIdDisable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        phone_masked: string | null;
                        is_enabled: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAdminUsersByUserIdEnable: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        phone_masked: string | null;
                        is_enabled: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminUsersByUserIdDevicesByDeviceIdRevoke: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                device_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminAuditActions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        value: string;
                        label: string;
                    }[];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminAuditLogs: {
        parameters: {
            query?: {
                page?: number;
                page_size?: 10 | 20 | 50 | 100;
                action?: string;
                actor_search?: string;
                target_search?: string;
                created_from?: string;
                created_to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            ip: string | null;
                            /** Format: date-time */
                            created_at: string;
                            action_label: string;
                            actor_display: string | null;
                            target_display: string | null;
                            summary: string | null;
                            reason: string | null;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        users: {
                            total: number;
                            enabled: number;
                        };
                        admins: {
                            total: number;
                            enabled: number;
                        };
                        ledgers: {
                            total: number;
                        };
                        devices: {
                            total: number;
                        };
                        sync_changes: {
                            total: number;
                        };
                        audit_logs: {
                            total: number;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAppBanners: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            slot: "fitness-plan-library" | "fitness-template-library";
                            image_path: string | null;
                            target: "fitness-plan-library" | "fitness-template-library" | "fitness-exercises" | "fitness-plans" | "fitness-templates";
                            is_enabled: boolean;
                            version: number;
                            updated_at: string | null;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listAdminBanners: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            slot: "fitness-plan-library" | "fitness-template-library";
                            image_path: string | null;
                            target: "fitness-plan-library" | "fitness-template-library" | "fitness-exercises" | "fitness-plans" | "fitness-templates";
                            is_enabled: boolean;
                            version: number;
                            updated_at: string | null;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateAdminBanner: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                slot: "fitness-plan-library" | "fitness-template-library";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    image_id: string | null;
                    target: "fitness-plan-library" | "fitness-template-library" | "fitness-exercises" | "fitness-plans" | "fitness-templates";
                    is_enabled: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        slot: "fitness-plan-library" | "fitness-template-library";
                        image_path: string | null;
                        target: "fitness-plan-library" | "fitness-template-library" | "fitness-exercises" | "fitness-plans" | "fitness-templates";
                        is_enabled: boolean;
                        version: number;
                        updated_at: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    uploadAdminBannerImage: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    filename: string;
                    data_base64: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        image_path: string;
                        width: number;
                        height: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAppBannerImage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminBannerImage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAnalyticsEvents: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    events: {
                        /** Format: uuid */
                        event_id: string;
                        /** Format: date-time */
                        occurred_at: string;
                        kind: "active" | "page_view" | "action";
                        page_id?: "home" | "accounting" | "accounting.transaction" | "accounting.transaction.editor" | "accounting.statistics" | "accounting.categories" | "accounting.aa_split.editor" | "accounting.aa_statistics" | "accounting.member_statistics" | "accounting.ledgers.edit" | "accounting.sharing" | "fitness" | "fitness.exercises" | "fitness.exercise" | "fitness.templates" | "fitness.template" | "fitness.plans" | "fitness.plan" | "fitness.workouts" | "fitness.workout" | "fitness.statistics" | "fitness.calendar" | "fitness.templates.library" | "fitness.templates.library.detail" | "fitness.plans.library.detail" | "fitness.library" | "fitness.workouts.editor" | "memos" | "memos.detail" | "memos.editor" | "credentials" | "credentials.detail" | "credentials.editor" | "credentials.books.edit" | "days" | "days.detail" | "days.editor" | "days.calendar" | "calendar" | "settings" | "settings.profile" | "accounting.categories.edit" | "accounting.categories.templates.flat" | "accounting.categories.templates.hierarchical" | "accounting.categories.detail" | "accounting.aa_member.detail" | "accounting.ledgers" | "accounting.ledgers.archived" | "accounting.ledgers.join" | "accounting.currency" | "accounting.exchange_rate" | "accounting.recurring.editor" | "fitness.spaces" | "fitness.spaces.edit" | "fitness.exercises.edit" | "fitness.templates.edit" | "fitness.plans.library" | "fitness.plans.edit" | "memos.tools" | "memos.books" | "memos.books.edit" | "days.tools" | "days.books" | "days.books.edit" | "settings.profile.name" | "settings.profile.avatar" | "settings.profile.gender" | "settings.reminder" | "settings.language" | "settings.theme" | "settings.app_lock" | "settings.cloud" | "settings.sync";
                        platform: "app" | "web";
                        app_version?: string;
                        event_name?: "home_view" | "accounting_view" | "accounting_transaction_view" | "accounting_transaction_editor_view" | "accounting_statistics_view" | "accounting_categories_view" | "accounting_aa_split_editor_view" | "accounting_aa_statistics_view" | "accounting_member_statistics_view" | "accounting_ledgers_edit_view" | "accounting_sharing_view" | "fitness_view" | "fitness_exercises_view" | "fitness_exercise_view" | "fitness_templates_view" | "fitness_template_view" | "fitness_plans_view" | "fitness_plan_view" | "fitness_workouts_view" | "fitness_workout_view" | "fitness_statistics_view" | "fitness_calendar_view" | "fitness_templates_library_view" | "fitness_templates_library_detail_view" | "fitness_plans_library_detail_view" | "fitness_library_view" | "fitness_workouts_editor_view" | "memos_view" | "memos_detail_view" | "memos_editor_view" | "credentials_view" | "credentials_detail_view" | "credentials_editor_view" | "credentials_books_edit_view" | "days_view" | "days_detail_view" | "days_editor_view" | "days_calendar_view" | "calendar_view" | "settings_view" | "settings_profile_view" | "accounting_categories_edit_view" | "accounting_categories_templates_flat_view" | "accounting_categories_templates_hierarchical_view" | "accounting_categories_detail_view" | "accounting_aa_member_detail_view" | "accounting_ledgers_view" | "accounting_ledgers_archived_view" | "accounting_ledgers_join_view" | "accounting_currency_view" | "accounting_exchange_rate_view" | "accounting_recurring_editor_view" | "fitness_spaces_view" | "fitness_spaces_edit_view" | "fitness_exercises_edit_view" | "fitness_templates_edit_view" | "fitness_plans_library_view" | "fitness_plans_edit_view" | "memos_tools_view" | "memos_books_view" | "memos_books_edit_view" | "days_tools_view" | "days_books_view" | "days_books_edit_view" | "settings_profile_name_view" | "settings_profile_avatar_view" | "settings_profile_gender_view" | "settings_reminder_view" | "settings_language_view" | "settings_theme_view" | "settings_app_lock_view" | "settings_cloud_view" | "settings_sync_view" | "navigation_mode_select" | "navigation_tab_select" | "accounting_ledger_select" | "accounting_transaction_create_click" | "accounting_transaction_open_click" | "accounting_transaction_edit_click" | "accounting_transaction_save_click" | "accounting_transaction_created" | "accounting_transaction_updated" | "accounting_transaction_deleted" | "accounting_statistics_open_click" | "accounting_categories_open_click" | "fitness_tab_select" | "fitness_space_select" | "fitness_workout_create_click" | "fitness_workout_open_click" | "fitness_workout_save_click" | "fitness_workout_created" | "fitness_workout_updated" | "fitness_workout_start_click" | "fitness_workout_started" | "fitness_workout_pause_click" | "fitness_workout_paused" | "fitness_workout_finish_click" | "fitness_workout_completed" | "fitness_template_save_click" | "fitness_template_saved" | "fitness_plan_save_click" | "fitness_plan_saved" | "fitness_template_add_click" | "fitness_template_added" | "fitness_plan_add_click" | "fitness_plan_added" | "memos_note_create_click" | "memos_note_open_click" | "memos_note_save_click" | "memos_note_saved" | "memos_note_created" | "memos_note_deleted" | "memos_book_select" | "credentials_create_click" | "credentials_open_click" | "credentials_save_click" | "credentials_saved" | "credentials_created" | "credentials_deleted" | "credentials_book_select" | "days_event_create_click" | "days_event_open_click" | "days_event_save_click" | "days_event_saved" | "days_event_created" | "days_event_deleted" | "days_book_select" | "calendar_day_select" | "calendar_section_open_click" | "calendar_create_click" | "settings_theme_changed" | "settings_language_changed" | "settings_app_lock_changed" | "settings_reminder_changed";
                        /** Format: uuid */
                        session_id: string;
                        event_sequence: number;
                        /** Format: uuid */
                        flow_id?: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        accepted: number;
                        duplicates: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminAnalytics: {
        parameters: {
            query: {
                start_date: string;
                end_date: string;
                platform?: "all" | "app" | "web";
                bucket?: "auto" | "hour" | "day" | "month";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        range: {
                            start_date: string;
                            end_date: string;
                            /** @enum {string} */
                            timezone: "Asia/Shanghai";
                            platform: "all" | "app" | "web";
                            bucket: "hour" | "day" | "month";
                        };
                        summary: {
                            new_users: number;
                            active_users: number;
                            page_views: number;
                        };
                        series: ({
                            /** Format: date-time */
                            period_start: string;
                        } & {
                            new_users: number;
                            active_users: number;
                            page_views: number;
                        })[];
                        coverage: {
                            /** Format: date-time */
                            collection_started_at: string;
                            complete: boolean;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminAnalyticsDetails: {
        parameters: {
            query: {
                start_date: string;
                end_date: string;
                platform?: "all" | "app" | "web";
                bucket?: "auto" | "hour" | "day" | "month";
                page_id?: "home" | "accounting" | "accounting.transaction" | "accounting.transaction.editor" | "accounting.statistics" | "accounting.categories" | "accounting.aa_split.editor" | "accounting.aa_statistics" | "accounting.member_statistics" | "accounting.ledgers.edit" | "accounting.sharing" | "fitness" | "fitness.exercises" | "fitness.exercise" | "fitness.templates" | "fitness.template" | "fitness.plans" | "fitness.plan" | "fitness.workouts" | "fitness.workout" | "fitness.statistics" | "fitness.calendar" | "fitness.templates.library" | "fitness.templates.library.detail" | "fitness.plans.library.detail" | "fitness.library" | "fitness.workouts.editor" | "memos" | "memos.detail" | "memos.editor" | "credentials" | "credentials.detail" | "credentials.editor" | "credentials.books.edit" | "days" | "days.detail" | "days.editor" | "days.calendar" | "calendar" | "settings" | "settings.profile" | "accounting.categories.edit" | "accounting.categories.templates.flat" | "accounting.categories.templates.hierarchical" | "accounting.categories.detail" | "accounting.aa_member.detail" | "accounting.ledgers" | "accounting.ledgers.archived" | "accounting.ledgers.join" | "accounting.currency" | "accounting.exchange_rate" | "accounting.recurring.editor" | "fitness.spaces" | "fitness.spaces.edit" | "fitness.exercises.edit" | "fitness.templates.edit" | "fitness.plans.library" | "fitness.plans.edit" | "memos.tools" | "memos.books" | "memos.books.edit" | "days.tools" | "days.books" | "days.books.edit" | "settings.profile.name" | "settings.profile.avatar" | "settings.profile.gender" | "settings.reminder" | "settings.language" | "settings.theme" | "settings.app_lock" | "settings.cloud" | "settings.sync";
                event_name?: "home_view" | "accounting_view" | "accounting_transaction_view" | "accounting_transaction_editor_view" | "accounting_statistics_view" | "accounting_categories_view" | "accounting_aa_split_editor_view" | "accounting_aa_statistics_view" | "accounting_member_statistics_view" | "accounting_ledgers_edit_view" | "accounting_sharing_view" | "fitness_view" | "fitness_exercises_view" | "fitness_exercise_view" | "fitness_templates_view" | "fitness_template_view" | "fitness_plans_view" | "fitness_plan_view" | "fitness_workouts_view" | "fitness_workout_view" | "fitness_statistics_view" | "fitness_calendar_view" | "fitness_templates_library_view" | "fitness_templates_library_detail_view" | "fitness_plans_library_detail_view" | "fitness_library_view" | "fitness_workouts_editor_view" | "memos_view" | "memos_detail_view" | "memos_editor_view" | "credentials_view" | "credentials_detail_view" | "credentials_editor_view" | "credentials_books_edit_view" | "days_view" | "days_detail_view" | "days_editor_view" | "days_calendar_view" | "calendar_view" | "settings_view" | "settings_profile_view" | "accounting_categories_edit_view" | "accounting_categories_templates_flat_view" | "accounting_categories_templates_hierarchical_view" | "accounting_categories_detail_view" | "accounting_aa_member_detail_view" | "accounting_ledgers_view" | "accounting_ledgers_archived_view" | "accounting_ledgers_join_view" | "accounting_currency_view" | "accounting_exchange_rate_view" | "accounting_recurring_editor_view" | "fitness_spaces_view" | "fitness_spaces_edit_view" | "fitness_exercises_edit_view" | "fitness_templates_edit_view" | "fitness_plans_library_view" | "fitness_plans_edit_view" | "memos_tools_view" | "memos_books_view" | "memos_books_edit_view" | "days_tools_view" | "days_books_view" | "days_books_edit_view" | "settings_profile_name_view" | "settings_profile_avatar_view" | "settings_profile_gender_view" | "settings_reminder_view" | "settings_language_view" | "settings_theme_view" | "settings_app_lock_view" | "settings_cloud_view" | "settings_sync_view" | "navigation_mode_select" | "navigation_tab_select" | "accounting_ledger_select" | "accounting_transaction_create_click" | "accounting_transaction_open_click" | "accounting_transaction_edit_click" | "accounting_transaction_save_click" | "accounting_transaction_created" | "accounting_transaction_updated" | "accounting_transaction_deleted" | "accounting_statistics_open_click" | "accounting_categories_open_click" | "fitness_tab_select" | "fitness_space_select" | "fitness_workout_create_click" | "fitness_workout_open_click" | "fitness_workout_save_click" | "fitness_workout_created" | "fitness_workout_updated" | "fitness_workout_start_click" | "fitness_workout_started" | "fitness_workout_pause_click" | "fitness_workout_paused" | "fitness_workout_finish_click" | "fitness_workout_completed" | "fitness_template_save_click" | "fitness_template_saved" | "fitness_plan_save_click" | "fitness_plan_saved" | "fitness_template_add_click" | "fitness_template_added" | "fitness_plan_add_click" | "fitness_plan_added" | "memos_note_create_click" | "memos_note_open_click" | "memos_note_save_click" | "memos_note_saved" | "memos_note_created" | "memos_note_deleted" | "memos_book_select" | "credentials_create_click" | "credentials_open_click" | "credentials_save_click" | "credentials_saved" | "credentials_created" | "credentials_deleted" | "credentials_book_select" | "days_event_create_click" | "days_event_open_click" | "days_event_save_click" | "days_event_saved" | "days_event_created" | "days_event_deleted" | "days_book_select" | "calendar_day_select" | "calendar_section_open_click" | "calendar_create_click" | "settings_theme_changed" | "settings_language_changed" | "settings_app_lock_changed" | "settings_reminder_changed";
                behavior?: "view" | "click" | "complete";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        range: {
                            start_date: string;
                            end_date: string;
                            /** @enum {string} */
                            timezone: "Asia/Shanghai";
                            platform: "all" | "app" | "web";
                            bucket: "hour" | "day" | "month";
                        };
                        summary: {
                            page_views: number;
                            visitors: number;
                            clicks: number;
                            click_users: number;
                            completions: number;
                            completion_users: number;
                        };
                        series: {
                            /** Format: date-time */
                            period_start: string;
                            page_views: number;
                            visitors: number;
                            clicks: number;
                            click_users: number;
                            completions: number;
                            completion_users: number;
                        }[];
                        pages: {
                            page_id: string;
                            event_name: string;
                            name: string;
                            page_views: number;
                            visitors: number;
                        }[];
                        events: {
                            event_name: string;
                            name: string;
                            behavior: "click" | "complete";
                            total: number;
                            users: number;
                        }[];
                        coverage: {
                            /** Format: date-time */
                            collection_started_at: string;
                            complete: boolean;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminAnalyticsCatalog: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        events: {
                            id: string;
                            event_name: string;
                            page_id: string | null;
                            kind: "page_view" | "action";
                            behavior: "view" | "click" | "complete";
                            name: string;
                            location: string;
                            platforms: ("app" | "web")[];
                            source_pages: {
                                page_id: string;
                                platforms: ("app" | "web")[];
                            }[];
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminAnalyticsFunnel: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    start_date: string;
                    end_date: string;
                    platform?: "all" | "app" | "web";
                    steps: string[];
                    scope: "user" | "session" | "flow";
                    window_minutes: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        range: {
                            start_date: string;
                            end_date: string;
                            /** @enum {string} */
                            timezone: "Asia/Shanghai";
                            platform: "all" | "app" | "web";
                        };
                        scope: "user" | "session" | "flow";
                        window_minutes: number;
                        steps: {
                            id: string;
                            name: string;
                            users: number;
                            conversion_rate: number | null;
                            drop_off: number;
                        }[];
                        completion_rate: number | null;
                        coverage: {
                            /** Format: date-time */
                            collection_started_at: string;
                            complete: boolean;
                            missing_context_events: number;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    putProfileAvatar: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content_type: "image/png" | "image/jpeg" | "image/webp";
                    data_base64: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        avatar_url: string;
                        avatar_version: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteProfileAvatar: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getProfileAvatarByUserId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/png": string;
                    "image/jpeg": string;
                    "image/webp": string;
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getProfileMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        user_id: string;
                        sesame_number: string | null;
                        display_name: string | null;
                        avatar_url: string | null;
                        avatar_version: number;
                        phone: string;
                        gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        theme_primary_color: string | null;
                        appearance: {
                            [key: string]: unknown;
                        } | null;
                        ai_config: {
                            [key: string]: unknown;
                        } | null;
                        primary_currency: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchProfileMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    display_name?: string | null;
                    gender?: string;
                    theme_primary_color?: string | null;
                    appearance?: {
                        [key: string]: unknown;
                    } | null;
                    ai_config?: {
                        [key: string]: unknown;
                    } | null;
                    primary_currency?: string | null;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        user_id: string;
                        sesame_number: string | null;
                        display_name: string | null;
                        avatar_url: string | null;
                        avatar_version: number;
                        phone: string;
                        gender: "UNSPECIFIED" | "MALE" | "FEMALE";
                        theme_primary_color: string | null;
                        appearance: {
                            [key: string]: unknown;
                        } | null;
                        ai_config: {
                            [key: string]: unknown;
                        } | null;
                        primary_currency: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getDevices: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        name: string;
                        platform: string;
                        app_version: string | null;
                        os_version: string | null;
                        device_model: string | null;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        last_seen_at: string;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        created_at: string;
                        revoked_at: string | null;
                        current: boolean;
                    }[];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteDevicesByDeviceId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                device_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getExchangeRateOverrides: {
        parameters: {
            query?: {
                base?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ExchangeRateOverride"][];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getExchangeRates: {
        parameters: {
            query: {
                base: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        base_currency: string;
                        rate_date: string | null;
                        source: string;
                        /** Format: date-time */
                        fetched_at: string;
                        rates: {
                            [key: string]: string;
                        };
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ledger"][];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                    id?: string;
                    name: string;
                    currency?: string;
                    month_start_day?: number;
                    aa_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ledger"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ledger"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteLedgersByLedgerId: {
        parameters: {
            query: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                expected_sync_id: string;
                expected_fingerprint: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchLedgersByLedgerId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    currency?: string;
                    month_start_day?: number;
                    aa_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Ledger"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdActionPreview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        name: string;
                        currency: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id: string;
                        fingerprint: string;
                        transaction_count: number;
                        recurring_count: number;
                        member_count: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdClear: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    mutation_id: string;
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    expected_sync_id: string;
                    expected_fingerprint: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        deleted_count: number;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id: string;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdChangeCurrency: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    currency: string;
                    expected_currency: string;
                    rates: {
                        [key: string]: string;
                    };
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ledger: components["schemas"]["Ledger"];
                        updated_transactions: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdCategories: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Category"][];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdCategories: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                    id?: string;
                    name: string;
                    /** @enum {string} */
                    kind: "expense";
                    level: 1 | 2;
                    sort_order?: number;
                    icon?: string | null;
                    parent_id?: string | null;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Category"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteLedgersByLedgerIdCategoriesByCategoryId: {
        parameters: {
            query?: {
                expected_version_token?: string;
            };
            header?: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                "idempotency-key"?: string;
            };
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                category_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchLedgersByLedgerIdCategoriesByCategoryId: {
        parameters: {
            query?: {
                expected_version_token?: string;
            };
            header?: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                "idempotency-key"?: string;
            };
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                category_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name?: string;
                    /** @enum {string} */
                    kind?: "expense";
                    level?: 1 | 2;
                    sort_order?: number;
                    icon?: string | null;
                    parent_id?: string | null;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Category"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getCategoryConflicts: {
        parameters: {
            query?: {
                status?: "pending" | "resolved" | "all";
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["CategoryConflict"][];
                        next_cursor: string | null;
                        has_more: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postCategoryConflictsByConflictIdResolve: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                conflict_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                    mutation_id: string;
                    expected_candidate_version: number;
                    expected_cloud_token: string;
                    choice: "cloud" | "local";
                    /** @enum {boolean} */
                    restore_deleted?: true;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CategoryResolution"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdCategoriesAddBatch: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    items: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id?: string;
                        name: string;
                        /** @enum {string} */
                        kind: "expense";
                        level: 1 | 2;
                        sort_order?: number;
                        icon?: string | null;
                        parent_id?: string | null;
                    }[];
                    /** @enum {boolean} */
                    initialize_defaults?: false;
                } | {
                    items: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id?: string;
                        name: string;
                        /** @enum {string} */
                        kind: "expense";
                        level: 1 | 2;
                        sort_order?: number;
                        icon?: string | null;
                        parent_id?: string | null;
                    }[];
                    /** @enum {boolean} */
                    initialize_defaults: true;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Category"][];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdCategoriesReorder: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    items: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        sort_order: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        expected_updated_at: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Category"][];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdCategoriesRemovalPreview: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    category_ids: string[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        preview_token: string;
                        categories: components["schemas"]["Category"][];
                        transaction_count: number;
                        recurring_count: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdCategoriesRemove: {
        parameters: {
            query?: never;
            header: {
                "idempotency-key": string;
            };
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    category_ids: string[];
                    mode: "migrate" | "delete" | "promote";
                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                    target_category_id?: string;
                    /**
                     * Format: date-time
                     * @example 2026-08-20T09:00:00.000Z
                     */
                    expected_target_updated_at?: string;
                    preview_token: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        removed_categories: number;
                        promoted_categories: number;
                        affected_transactions: number;
                        affected_recurring_rules: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdTransactions: {
        parameters: {
            query?: {
                /** @example 2026-08-20T09:00:00.000Z */
                start_at?: string;
                /** @example 2026-08-20T09:00:00.000Z */
                end_at?: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                payer_member_id?: string;
                aa_mode?: number;
                currency_code?: string;
                category_id?: string | "uncategorized";
                time_zone?: string;
                limit?: number;
                cursor?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["Transaction"][];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdTransactions: {
        parameters: {
            query?: never;
            header?: {
                "idempotency-key"?: string;
            };
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                    id?: string;
                    /** @enum {string} */
                    tx_type: "expense";
                    amount: string;
                    /**
                     * Format: date-time
                     * @example 2026-08-20T09:00:00.000Z
                     */
                    happened_at: string;
                    note?: string | null;
                    category_id?: string | null;
                    currency_code: string;
                    native_amount: string;
                    recurring_id?: string | null;
                    occurrence_date?: string | null;
                    payer_member_id?: string | null;
                    aa_mode?: "0" | "1" | "2" | null;
                    splits?: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        member_id: string;
                        amount: string;
                    }[] | null;
                    base_revision?: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Transaction"];
                };
            };
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Transaction"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteLedgersByLedgerIdTransactionsByTransactionId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                transaction_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    base_revision: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchLedgersByLedgerIdTransactionsByTransactionId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                transaction_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    tx_type?: "expense";
                    amount?: string;
                    /**
                     * Format: date-time
                     * @example 2026-08-20T09:00:00.000Z
                     */
                    happened_at?: string;
                    note?: string | null;
                    category_id?: string | null;
                    currency_code?: string;
                    native_amount?: string;
                    recurring_id?: string | null;
                    occurrence_date?: string | null;
                    payer_member_id?: string | null;
                    aa_mode?: "0" | "1" | "2" | null;
                    splits?: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        member_id: string;
                        amount: string;
                    }[] | null;
                    base_revision: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Transaction"];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdRecurringTransactions: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["RecurringTransaction"][];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdRecurringTransactionsGenerateDue: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    mutation_id: string;
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    expected_sync_id: string;
                    expected_currency: string;
                    rates?: {
                        [key: string]: string;
                    };
                    limit?: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        generated_count: number;
                        skipped_count: number;
                        has_more: boolean;
                        rule_cursors: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            last_generated_date: string | null;
                        }[];
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdTransactionStats: {
        parameters: {
            query?: {
                /** @example 2026-08-20T09:00:00.000Z */
                start_at?: string;
                /** @example 2026-08-20T09:00:00.000Z */
                end_at?: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                payer_member_id?: string;
                aa_mode?: number;
                currency_code?: string;
                category_id?: string | "uncategorized";
                time_zone?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ledger_currency: string;
                        expense_total: string;
                        transaction_count: number;
                        by_currency: {
                            currency_code: string;
                            amount_total: string;
                            native_total: string;
                            transaction_count: number;
                        }[];
                        by_day: {
                            date: string;
                            native_total: string;
                            transaction_count: number;
                        }[];
                        by_category: {
                            category_id: string | null;
                            category_name: string | null;
                            native_total: string;
                            transaction_count: number;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdAaStats: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ledger_currency: string;
                        aa_enabled: boolean;
                        transaction_count: number;
                        excluded_count: number;
                        skipped_count: number;
                        participants: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            member_id: string;
                            display_name: string;
                            is_self: boolean;
                            total_paid: string;
                            total_should_pay: string;
                            net: string;
                            non_split_paid: string;
                        }[];
                        transfers: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            from_member_id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            to_member_id: string;
                            amount: string;
                            exact_amount: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdMemberStats: {
        parameters: {
            query?: {
                scope?: "month" | "year" | "all";
                /** @description creator按记录人汇总全部未删除支出；payer按付款人汇总全部未删除支出，不含未指定付款人的交易。 */
                dimension?: "creator" | "payer";
                period?: string;
                tz_offset_minutes?: number;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        ledger_currency: string;
                        scope: "month" | "year" | "all";
                        period: string | null;
                        start_at: string | null;
                        end_at: string | null;
                        items: {
                            user_id: string | null;
                            member_id?: string | null;
                            sesame_number: string | null;
                            display_name: string | null;
                            avatar_url: string | null;
                            avatar_version: number;
                            role: "owner" | "editor" | "removed" | "unknown";
                            expense_total: string;
                            tx_count: number;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdSharedResources: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        owner_user_id: string;
                        categories: components["schemas"]["Category"][];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        user_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        member_id: string;
                        status: "ACTIVE" | "LEFT" | "REMOVED";
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        linked_account_id: string;
                        sesame_number: string | null;
                        display_name: string | null;
                        avatar_url: string | null;
                        avatar_version: number;
                        role: "owner" | "editor";
                        /** Format: date-time */
                        joined_at: string;
                    }[];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteLedgersByLedgerIdMembersByMemberId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                member_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdLeave: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdInvites: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    expires_in_hours?: number;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        /** @enum {string} */
                        role: "editor";
                        /** Format: date-time */
                        expires_at: string;
                    } & {
                        code: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getInvitesByCode: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        ledger_name: string;
                        /** @enum {string} */
                        role: "editor";
                        /** Format: date-time */
                        expires_at: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postInvitesByCodeAccept: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                code: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        ledger_name: string;
                        /** @enum {string} */
                        role: "editor";
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getLedgersByLedgerIdParticipants: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Member"][];
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getMemoBooksByMemoBookIdEntries: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
                /** @example 2026-08-20T09:00:00.000Z */
                start_at?: string;
                /** @example 2026-08-20T09:00:00.000Z */
                end_at?: string;
                time_zone?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                memo_book_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["MemoEntry"][];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getDayBooksByDayBookIdEvents: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                day_book_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["DayEvent"][];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getMemoBooksByMemoBookIdCalendarCounts: {
        parameters: {
            query?: {
                /** @example 2026-08-20T09:00:00.000Z */
                start_at?: string;
                /** @example 2026-08-20T09:00:00.000Z */
                end_at?: string;
                time_zone?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                memo_book_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        days: {
                            date: string;
                            count: number;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdTemplates: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            name: string;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                }[];
                            }[];
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdPlans: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            name: string;
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            start_date: string | null;
                            status: "in_progress" | "closed";
                            cycle_days: number;
                            days: {
                                day_index: number;
                                slot: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    source_template_id: string | null;
                                    name: string;
                                    exercises: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        exercise_id: string;
                                        rest_seconds: number;
                                        warmup_rest_seconds: number | null;
                                        sets: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            kind: "warmup" | "working";
                                            weight: string | null;
                                            weight_left: string | null;
                                            weight_right: string | null;
                                            reps: number | null;
                                        }[];
                                    }[];
                                } | null;
                            }[];
                            generation_state: {
                                next_cycle_start_date: string | null;
                                next_cycle_index: number;
                                generated_cycles: {
                                    cycle_index: number;
                                    start_date: string;
                                    cycle_days: number;
                                    generated_from_date: string;
                                    rest_dates: string[];
                                }[];
                            };
                            pending_schedule: {
                                cycle_days: number;
                                days: {
                                    day_index: number;
                                    slot: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        source_template_id: string | null;
                                        name: string;
                                        exercises: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            exercise_id: string;
                                            rest_seconds: number;
                                            warmup_rest_seconds: number | null;
                                            sets: {
                                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                id: string;
                                                kind: "warmup" | "working";
                                                weight: string | null;
                                                weight_left: string | null;
                                                weight_right: string | null;
                                                reps: number | null;
                                            }[];
                                        }[];
                                    } | null;
                                }[];
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdWorkouts: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
                exercise_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            name: string;
                            scheduled_date: string;
                            source_kind: "blank" | "template" | "plan";
                            source_plan_id: string | null;
                            source_plan_name: string | null;
                            source_template_id: string | null;
                            occurrence_key: string | null;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                    completed: boolean;
                                    rest_durations_seconds?: number[];
                                }[];
                            }[];
                            status: "scheduled" | "in_progress" | "completed";
                            run_segments: {
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                started_at: string;
                                ended_at: string | null;
                            }[];
                            rest_timer: {
                                status: "running" | "paused";
                                ends_at: string | null;
                                remaining_seconds: number;
                                duration_seconds: number;
                                elapsed_seconds?: number;
                                exercise_id?: string | null;
                                set_id?: string | null;
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdPreferences: {
        parameters: {
            query?: {
                limit?: number;
                cursor?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            custom_exercises: {
                                id: string;
                                name: string;
                                body_part: string;
                                equipment: string;
                                icon: string;
                                image: string | null;
                                deleted: boolean;
                            }[];
                            default_rest_seconds: number;
                            default_warmup_rest_seconds?: number;
                            exercise_rest_settings?: {
                                [key: string]: {
                                    rest_seconds: number;
                                    warmup_rest_seconds: number;
                                };
                            };
                            sound_enabled: boolean;
                            vibration_enabled: boolean;
                            pinned_exercise_ids: string[];
                            exercise_weight_modes: {
                                [key: string]: boolean;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        next_cursor: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postSyncPush: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    device_id: string;
                    changes: (({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "day_book";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        day_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            name: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "day_book";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        day_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: {
                            /** @description 删除日子本时需提供完整同步返回的 server_cursor，用于确认本内内容未变化。 */
                            expected_full_cursor?: string;
                        };
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "day_event";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        day_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            name: string;
                            category: "birthday" | "anniversary" | "countdown" | "stage";
                            countdown_mode: "fixed_date" | "interval_days" | null;
                            interval_days: number | null;
                            repeat_type: "none" | "yearly";
                            statistic_type: "year" | "day";
                            event: {
                                calendar_type: "solar" | "lunar";
                                original_year: number;
                                original_month: number;
                                original_day: number;
                                is_leap_month: boolean;
                                solar_date: string;
                            } | null;
                            start: {
                                calendar_type: "solar" | "lunar";
                                original_year: number;
                                original_month: number;
                                original_day: number;
                                is_leap_month: boolean;
                                solar_date: string;
                            } | null;
                            end: {
                                calendar_type: "solar" | "lunar";
                                original_year: number;
                                original_month: number;
                                original_day: number;
                                is_leap_month: boolean;
                                solar_date: string;
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "day_event";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        day_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "ledger";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "upsert";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            name: string;
                            currency: string;
                            month_start_day: number;
                            aa_enabled: boolean;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "ledger";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "delete";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            expected_full_cursor?: string;
                        };
                    }) | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "ledger_archive";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id: string;
                        /** @enum {string} */
                        action: "upsert";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            archived: boolean;
                        };
                    } | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "transaction";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "upsert";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            /** @enum {string} */
                            tx_type: "expense";
                            amount: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            happened_at: string;
                            note: string | null;
                            category_id: string | null;
                            currency_code: string;
                            native_amount: string;
                            recurring_id: string | null;
                            occurrence_date?: string | null;
                            payer_member_id?: string | null;
                            aa_mode: "0" | "1" | "2" | null;
                            splits: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                member_id: string;
                                amount: string;
                            }[] | null;
                            last_edited_at: string | null;
                            /** @enum {boolean} */
                            initial_history?: true;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "transaction";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "delete";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "category";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "upsert";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            base_token?: string;
                            name: string;
                            /** @enum {string} */
                            kind: "expense";
                            level: 1 | 2;
                            sort_order: number;
                            icon: string | null;
                            parent_id: string | null;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "category";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "delete";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            base_token?: string;
                        };
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "recurring_transaction";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "upsert";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            /** @enum {string} */
                            tx_type: "expense";
                            amount: string;
                            currency_code: string;
                            category_id: string | null;
                            note: string | null;
                            frequency: "daily" | "weekly" | "monthly" | "yearly";
                            interval: number;
                            day_of_month: number | null;
                            day_of_week: number | null;
                            month_of_year: number | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            start_date: string;
                            end_date: string | null;
                            /** @enum {number} */
                            protocol_version: 1;
                            time_zone: string;
                            enabled: boolean;
                            initial_state?: {
                                last_generated_date: string | null;
                                deleted_at: string | null;
                                occurrences: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    deleted_at: string | null;
                                    payload: {
                                        /** @enum {string} */
                                        tx_type: "expense";
                                        amount: string;
                                        /**
                                         * Format: date-time
                                         * @example 2026-08-20T09:00:00.000Z
                                         */
                                        happened_at: string;
                                        note: string | null;
                                        category_id: string | null;
                                        currency_code: string;
                                        native_amount: string;
                                        recurring_id: string | null;
                                        occurrence_date?: string | null;
                                        payer_member_id?: string | null;
                                        aa_mode: "0" | "1" | "2" | null;
                                        splits: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            member_id: string;
                                            amount: string;
                                        }[] | null;
                                        last_edited_at: string | null;
                                    };
                                }[];
                            };
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "recurring_transaction";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "delete";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "exchange_rate_override";
                        /** @example 1527ffc3-6087-5b6b-99c6-c6837a5db1b6 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "upsert";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            base_currency: string;
                            quote_currency: string;
                            rate: string;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "exchange_rate_override";
                        /** @example 1527ffc3-6087-5b6b-99c6-c6837a5db1b6 */
                        entity_id: string;
                        ledger_id: null;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "delete";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "member";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "upsert";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: {
                            display_name: string;
                            initial_status?: "ACTIVE" | "LEFT" | "REMOVED";
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "member";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        ledger_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /** @enum {string} */
                        action: "delete";
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "memo_book";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        memo_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            name: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            restore?: boolean;
                            expected_full_cursor?: string;
                            type: "normal" | "credentials";
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "memo_book";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        memo_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: {
                            expected_full_cursor: string;
                        };
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "memo_entry";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        memo_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            book_type: "normal" | "credentials";
                            title: string;
                            body_format: "delta_v1" | "fields_v1" | null;
                            body: {
                                [key: string]: unknown;
                            } | null;
                            order_key: string | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "memo_entry";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        memo_book_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_template";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            name: string;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                }[];
                            }[];
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        deleted_at?: string;
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_template";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_plan";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            name: string;
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            start_date: string | null;
                            status: "in_progress" | "closed";
                            cycle_days: number;
                            days: {
                                day_index: number;
                                slot: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    source_template_id: string | null;
                                    name: string;
                                    exercises: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        exercise_id: string;
                                        rest_seconds: number;
                                        warmup_rest_seconds: number | null;
                                        sets: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            kind: "warmup" | "working";
                                            weight: string | null;
                                            weight_left: string | null;
                                            weight_right: string | null;
                                            reps: number | null;
                                        }[];
                                    }[];
                                } | null;
                            }[];
                            generation_state: {
                                next_cycle_start_date: string | null;
                                next_cycle_index: number;
                                generated_cycles: {
                                    cycle_index: number;
                                    start_date: string;
                                    cycle_days: number;
                                    generated_from_date: string;
                                    rest_dates: string[];
                                }[];
                            };
                            pending_schedule: {
                                cycle_days: number;
                                days: {
                                    day_index: number;
                                    slot: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        source_template_id: string | null;
                                        name: string;
                                        exercises: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            exercise_id: string;
                                            rest_seconds: number;
                                            warmup_rest_seconds: number | null;
                                            sets: {
                                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                id: string;
                                                kind: "warmup" | "working";
                                                weight: string | null;
                                                weight_left: string | null;
                                                weight_right: string | null;
                                                reps: number | null;
                                            }[];
                                        }[];
                                    } | null;
                                }[];
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        deleted_at?: string;
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_plan";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_workout";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            name: string;
                            scheduled_date: string;
                            source_kind: "blank" | "template" | "plan";
                            source_plan_id: string | null;
                            source_plan_name: string | null;
                            source_template_id: string | null;
                            occurrence_key: string | null;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                    completed: boolean;
                                    rest_durations_seconds?: number[];
                                }[];
                            }[];
                            status: "scheduled" | "in_progress" | "completed";
                            run_segments: {
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                started_at: string;
                                ended_at: string | null;
                            }[];
                            rest_timer: {
                                status: "running" | "paused";
                                ends_at: string | null;
                                remaining_seconds: number;
                                duration_seconds: number;
                                elapsed_seconds?: number;
                                exercise_id?: string | null;
                                set_id?: string | null;
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        deleted_at?: string;
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_workout";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_preferences";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            custom_exercises: {
                                id: string;
                                name: string;
                                body_part: string;
                                equipment: string;
                                icon: string;
                                image: string | null;
                                deleted: boolean;
                            }[];
                            default_rest_seconds: number;
                            default_warmup_rest_seconds?: number;
                            exercise_rest_settings?: {
                                [key: string]: {
                                    rest_seconds: number;
                                    warmup_rest_seconds: number;
                                };
                            };
                            sound_enabled: boolean;
                            vibration_enabled: boolean;
                            pinned_exercise_ids: string[];
                            exercise_weight_modes: {
                                [key: string]: boolean;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        deleted_at?: string;
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_preferences";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: Record<string, never>;
                    }) | ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_space";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "upsert";
                        payload: {
                            name: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            restore?: boolean;
                            expected_full_cursor?: string;
                        };
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        deleted_at?: string;
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        mutation_id: string;
                        /** @enum {string} */
                        entity_type: "fitness_space";
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        entity_id: string;
                        ledger_id: null;
                        day_book_id: null;
                        memo_book_id: null;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id?: string;
                        base_revision?: number;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @enum {string} */
                        action: "delete";
                        payload: {
                            expected_full_cursor: string;
                        };
                    }))[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        outcomes: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            mutation_id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            entity_id: string;
                            status: "accepted" | "ignored" | "conflict" | "invalid";
                            change_id: string | null;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id?: string;
                            revision?: number;
                            current_revision?: number;
                            current_deleted?: boolean;
                            current_entity?: unknown;
                            category_state?: components["schemas"]["Category"];
                            category_conflict?: components["schemas"]["CategoryConflict"];
                            category_resolution?: components["schemas"]["CategoryResolution"];
                            blocking_entity?: unknown;
                            code?: string;
                            message?: string;
                        }[];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            412: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncFitnessSpaces: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        fitness_spaces: {
                            name: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            restore?: boolean;
                            expected_full_cursor?: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                            entity_count: number;
                        }[];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncFitnessSpacesFull: {
        parameters: {
            query: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        fitness_space: {
                            name: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            restore?: boolean;
                            expected_full_cursor?: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        };
                        fitness_templates: {
                            name: string;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                }[];
                            }[];
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        fitness_plans: {
                            name: string;
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            start_date: string | null;
                            status: "in_progress" | "closed";
                            cycle_days: number;
                            days: {
                                day_index: number;
                                slot: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    source_template_id: string | null;
                                    name: string;
                                    exercises: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        exercise_id: string;
                                        rest_seconds: number;
                                        warmup_rest_seconds: number | null;
                                        sets: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            kind: "warmup" | "working";
                                            weight: string | null;
                                            weight_left: string | null;
                                            weight_right: string | null;
                                            reps: number | null;
                                        }[];
                                    }[];
                                } | null;
                            }[];
                            generation_state: {
                                next_cycle_start_date: string | null;
                                next_cycle_index: number;
                                generated_cycles: {
                                    cycle_index: number;
                                    start_date: string;
                                    cycle_days: number;
                                    generated_from_date: string;
                                    rest_dates: string[];
                                }[];
                            };
                            pending_schedule: {
                                cycle_days: number;
                                days: {
                                    day_index: number;
                                    slot: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        source_template_id: string | null;
                                        name: string;
                                        exercises: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            exercise_id: string;
                                            rest_seconds: number;
                                            warmup_rest_seconds: number | null;
                                            sets: {
                                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                id: string;
                                                kind: "warmup" | "working";
                                                weight: string | null;
                                                weight_left: string | null;
                                                weight_right: string | null;
                                                reps: number | null;
                                            }[];
                                        }[];
                                    } | null;
                                }[];
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        fitness_workouts: {
                            name: string;
                            scheduled_date: string;
                            source_kind: "blank" | "template" | "plan";
                            source_plan_id: string | null;
                            source_plan_name: string | null;
                            source_template_id: string | null;
                            occurrence_key: string | null;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                    completed: boolean;
                                    rest_durations_seconds?: number[];
                                }[];
                            }[];
                            status: "scheduled" | "in_progress" | "completed";
                            run_segments: {
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                started_at: string;
                                ended_at: string | null;
                            }[];
                            rest_timer: {
                                status: "running" | "paused";
                                ends_at: string | null;
                                remaining_seconds: number;
                                duration_seconds: number;
                                elapsed_seconds?: number;
                                exercise_id?: string | null;
                                set_id?: string | null;
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        fitness_preferences: {
                            custom_exercises: {
                                id: string;
                                name: string;
                                body_part: string;
                                equipment: string;
                                icon: string;
                                image: string | null;
                                deleted: boolean;
                            }[];
                            default_rest_seconds: number;
                            default_warmup_rest_seconds?: number;
                            exercise_rest_settings?: {
                                [key: string]: {
                                    rest_seconds: number;
                                    warmup_rest_seconds: number;
                                };
                            };
                            sound_enabled: boolean;
                            vibration_enabled: boolean;
                            pinned_exercise_ids: string[];
                            exercise_weight_modes: {
                                [key: string]: boolean;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        }[];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncPull: {
        parameters: {
            query?: {
                since?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        changes: {
                            change_id: string;
                            ledger_id: string | null;
                            day_book_id: string | null;
                            memo_book_id: string | null;
                            fitness_space_id: string | null;
                            entity_type: "ledger" | "ledger_archive" | "transaction" | "category" | "recurring_transaction" | "exchange_rate_override" | "member" | "day_book" | "day_event" | "memo_book" | "memo_entry" | "fitness_space" | "fitness_template" | "fitness_plan" | "fitness_workout" | "fitness_preferences";
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            entity_id: string;
                            action: "upsert" | "delete";
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            mutation_id: string;
                            payload: {
                                [key: string]: unknown;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            device_id: string;
                        }[];
                        server_cursor: string;
                        has_more: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            410: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncFull: {
        parameters: {
            query: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
                include_recurring_state?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ledger: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            owner_id?: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            name: string;
                            currency: string;
                            month_start_day: number;
                            aa_enabled: boolean;
                            archived_at: string | null;
                            archive_updated_at: string | null;
                            archive_device_id: string | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                        members: components["schemas"]["Member"][];
                        transactions: components["schemas"]["Transaction"][];
                        categories: components["schemas"]["Category"][];
                        category_tombstones: components["schemas"]["Category"][];
                        recurring_transactions: components["schemas"]["RecurringTransaction"][];
                        exchange_rate_overrides: components["schemas"]["ExchangeRateOverride"][];
                        recurring_state?: {
                            rules: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                ledger_id: string;
                                /** @enum {string} */
                                tx_type: "expense";
                                amount: string;
                                currency_code: string;
                                category_id: string | null;
                                note: string | null;
                                frequency: "daily" | "weekly" | "monthly" | "yearly";
                                interval: number;
                                day_of_month: number | null;
                                day_of_week: number | null;
                                month_of_year: number | null;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                start_date: string;
                                end_date: string | null;
                                last_generated_date: string | null;
                                /** @enum {number} */
                                protocol_version: 1;
                                time_zone: string;
                                enabled: boolean;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                updated_at: string;
                                deleted_at: string | null;
                            }[];
                            occurrences: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                ledger_id: string;
                                /** @enum {string} */
                                tx_type: "expense";
                                amount: string;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                happened_at: string;
                                note: string | null;
                                category_id: string | null;
                                category_name: string | null;
                                category_kind: "expense" | null;
                                currency_code: string;
                                native_amount: string;
                                recurring_id: string | null;
                                occurrence_date: string | null;
                                created_by_member_id: string | null;
                                last_edited_by_member_id: string | null;
                                payer_member_id: string | null;
                                aa_mode: "0" | "1" | "2" | null;
                                splits: components["schemas"]["TransactionSplit"][];
                                revision: number;
                                last_edited_at: string | null;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                updated_at: string;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                created_at: string;
                                deleted_at: string | null;
                            }[];
                        };
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncMemoBooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        memo_books: {
                            name: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            restore?: boolean;
                            expected_full_cursor?: string;
                            type: "normal" | "credentials";
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                            entry_count: number;
                        }[];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncMemoBooksFull: {
        parameters: {
            query: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                memo_book_id: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        memo_book: components["schemas"]["MemoBook"];
                        memo_entries: components["schemas"]["MemoEntry"][];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncDayBooks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        day_books: components["schemas"]["DayBook"][];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncDayBooksFull: {
        parameters: {
            query: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                day_book_id: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        day_book: components["schemas"]["DayBook"];
                        day_events: components["schemas"]["DayEvent"][];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getSyncAccountingFull: {
        parameters: {
            query?: {
                include_recurring_state?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ledger_snapshots: {
                            ledger: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                owner_id?: string;
                                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                                sync_id: string;
                                name: string;
                                currency: string;
                                month_start_day: number;
                                aa_enabled: boolean;
                                archived_at: string | null;
                                archive_updated_at: string | null;
                                archive_device_id: string | null;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                updated_at: string;
                            };
                            members: components["schemas"]["Member"][];
                            transactions: components["schemas"]["Transaction"][];
                            categories: components["schemas"]["Category"][];
                            category_tombstones: components["schemas"]["Category"][];
                            recurring_transactions: components["schemas"]["RecurringTransaction"][];
                            exchange_rate_overrides: components["schemas"]["ExchangeRateOverride"][];
                            recurring_state?: {
                                rules: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    ledger_id: string;
                                    /** @enum {string} */
                                    tx_type: "expense";
                                    amount: string;
                                    currency_code: string;
                                    category_id: string | null;
                                    note: string | null;
                                    frequency: "daily" | "weekly" | "monthly" | "yearly";
                                    interval: number;
                                    day_of_month: number | null;
                                    day_of_week: number | null;
                                    month_of_year: number | null;
                                    /**
                                     * Format: date-time
                                     * @example 2026-08-20T09:00:00.000Z
                                     */
                                    start_date: string;
                                    end_date: string | null;
                                    last_generated_date: string | null;
                                    /** @enum {number} */
                                    protocol_version: 1;
                                    time_zone: string;
                                    enabled: boolean;
                                    /**
                                     * Format: date-time
                                     * @example 2026-08-20T09:00:00.000Z
                                     */
                                    updated_at: string;
                                    deleted_at: string | null;
                                }[];
                                occurrences: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    ledger_id: string;
                                    /** @enum {string} */
                                    tx_type: "expense";
                                    amount: string;
                                    /**
                                     * Format: date-time
                                     * @example 2026-08-20T09:00:00.000Z
                                     */
                                    happened_at: string;
                                    note: string | null;
                                    category_id: string | null;
                                    category_name: string | null;
                                    category_kind: "expense" | null;
                                    currency_code: string;
                                    native_amount: string;
                                    recurring_id: string | null;
                                    occurrence_date: string | null;
                                    created_by_member_id: string | null;
                                    last_edited_by_member_id: string | null;
                                    payer_member_id: string | null;
                                    aa_mode: "0" | "1" | "2" | null;
                                    splits: components["schemas"]["TransactionSplit"][];
                                    revision: number;
                                    last_edited_at: string | null;
                                    /**
                                     * Format: date-time
                                     * @example 2026-08-20T09:00:00.000Z
                                     */
                                    updated_at: string;
                                    /**
                                     * Format: date-time
                                     * @example 2026-08-20T09:00:00.000Z
                                     */
                                    created_at: string;
                                    deleted_at: string | null;
                                }[];
                            };
                        }[];
                        categories: components["schemas"]["Category"][];
                        exchange_rate_overrides: components["schemas"]["ExchangeRateOverride"][];
                        category_tombstones: components["schemas"]["Category"][];
                        deleted_exchange_rate_override_ids: string[];
                        server_cursor: string;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessLibrary: {
        parameters: {
            query?: never;
            header?: {
                "if-none-match"?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        schema_version: number;
                        content_version: number;
                        templates: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            revision: number;
                            name: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            description: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            difficulty: "beginner" | "intermediate" | "advanced";
                            goals: {
                                zh: string[];
                                zh_hant: string[];
                                en: string[];
                            };
                            duration_minutes: number;
                            equipment: string[];
                            exercises: {
                                exercise_id: string;
                                sets: number;
                                reps: number;
                                weight_kg: string | null;
                                weight_mode: "total" | "per_side" | "body_weight";
                                rest_seconds: number;
                            }[];
                        }[];
                        plans: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            revision: number;
                            name: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            description: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            difficulty: "beginner" | "intermediate" | "advanced";
                            goals: {
                                zh: string[];
                                zh_hant: string[];
                                en: string[];
                            };
                            cycle_days: number;
                            days: {
                                day_index: number;
                                template_id: string | null;
                            }[];
                        }[];
                    };
                };
            };
            /** @description Default Response */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listOfficialFitnessTaxonomies: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "body_part" | "equipment";
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            name: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            is_deleted: boolean;
                            kind: "body_part" | "equipment";
                            sort_order: number;
                            version: number;
                            exercise_count: number;
                            template_count: number;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    createOfficialFitnessTaxonomy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "body_part" | "equipment";
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    name: {
                        zh: string;
                        zh_hant: string;
                        en: string;
                    };
                    sort_order?: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        is_deleted: boolean;
                        kind: "body_part" | "equipment";
                        sort_order: number;
                        version: number;
                        exercise_count: number;
                        template_count: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteOfficialFitnessTaxonomy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "body_part" | "equipment";
                taxon_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    replacement_id?: string;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    updateOfficialFitnessTaxonomy: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                kind: "body_part" | "equipment";
                taxon_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    name?: {
                        zh: string;
                        zh_hant: string;
                        en: string;
                    };
                    sort_order?: number;
                    reason: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        name: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        is_deleted: boolean;
                        kind: "body_part" | "equipment";
                        sort_order: number;
                        version: number;
                        exercise_count: number;
                        template_count: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listOfficialFitnessReferences: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        exercises: {
                            id: string;
                            name: string;
                            is_enabled: boolean;
                        }[];
                        templates: {
                            id: string;
                            name: string;
                            is_enabled: boolean;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listOfficialExercises: {
        parameters: {
            query?: {
                q?: string;
                page?: number;
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            kind: "exercise" | "template" | "plan";
                            version: number;
                            content: {
                                id: string;
                                name_zh: string;
                                name_zh_hant: string;
                                name_en: string;
                                body_part: string;
                                equipment: string;
                                target: string;
                                secondary_muscles: string[];
                                instructions_zh: string[];
                                instructions_zh_hant: string[];
                                instructions_en: string[];
                                attribution: string;
                                gif_asset: string;
                                media_id?: string | null;
                            };
                            is_enabled: boolean;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                            updated_by: string | null;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                        next_cursor: null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminFitnessExercises: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content: {
                        name_zh: string;
                        name_zh_hant: string;
                        name_en: string;
                        body_part: string;
                        equipment: string;
                        target: string;
                        secondary_muscles: string[];
                        instructions_zh: string[];
                        instructions_zh_hant: string[];
                        instructions_en: string[];
                        attribution: string;
                        gif_asset: string;
                        media_id?: string | null;
                    };
                    is_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        kind: "exercise" | "template" | "plan";
                        version: number;
                        content: {
                            id: string;
                            name_zh: string;
                            name_zh_hant: string;
                            name_en: string;
                            body_part: string;
                            equipment: string;
                            target: string;
                            secondary_muscles: string[];
                            instructions_zh: string[];
                            instructions_zh_hant: string[];
                            instructions_en: string[];
                            attribution: string;
                            gif_asset: string;
                            media_id?: string | null;
                        };
                        is_enabled: boolean;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                        updated_by: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAdminFitnessExercisesByContentId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                content_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    content?: {
                        name_zh: string;
                        name_zh_hant: string;
                        name_en: string;
                        body_part: string;
                        equipment: string;
                        target: string;
                        secondary_muscles: string[];
                        instructions_zh: string[];
                        instructions_zh_hant: string[];
                        instructions_en: string[];
                        attribution: string;
                        gif_asset: string;
                        media_id?: string | null;
                    };
                    is_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        kind: "exercise" | "template" | "plan";
                        version: number;
                        content: {
                            id: string;
                            name_zh: string;
                            name_zh_hant: string;
                            name_en: string;
                            body_part: string;
                            equipment: string;
                            target: string;
                            secondary_muscles: string[];
                            instructions_zh: string[];
                            instructions_zh_hant: string[];
                            instructions_en: string[];
                            attribution: string;
                            gif_asset: string;
                            media_id?: string | null;
                        };
                        is_enabled: boolean;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                        updated_by: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listOfficialTemplates: {
        parameters: {
            query?: {
                q?: string;
                page?: number;
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            kind: "exercise" | "template" | "plan";
                            version: number;
                            content: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                revision: number;
                                name: {
                                    zh: string;
                                    zh_hant: string;
                                    en: string;
                                };
                                description: {
                                    zh: string;
                                    zh_hant: string;
                                    en: string;
                                };
                                difficulty: "beginner" | "intermediate" | "advanced";
                                goals: {
                                    zh: string[];
                                    zh_hant: string[];
                                    en: string[];
                                };
                                duration_minutes: number;
                                equipment: string[];
                                exercises: {
                                    exercise_id: string;
                                    sets: number;
                                    reps: number;
                                    weight_kg: string | null;
                                    weight_mode: "total" | "per_side" | "body_weight";
                                    rest_seconds: number;
                                }[];
                            };
                            is_enabled: boolean;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                            updated_by: string | null;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                        next_cursor: null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminFitnessTemplates: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content: {
                        name: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        description: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        difficulty: "beginner" | "intermediate" | "advanced";
                        goals: {
                            zh: string[];
                            zh_hant: string[];
                            en: string[];
                        };
                        duration_minutes: number;
                        equipment: string[];
                        exercises: {
                            exercise_id: string;
                            sets: number;
                            reps: number;
                            weight_kg: string | null;
                            weight_mode: "total" | "per_side" | "body_weight";
                            rest_seconds: number;
                        }[];
                    };
                    is_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        kind: "exercise" | "template" | "plan";
                        version: number;
                        content: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            revision: number;
                            name: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            description: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            difficulty: "beginner" | "intermediate" | "advanced";
                            goals: {
                                zh: string[];
                                zh_hant: string[];
                                en: string[];
                            };
                            duration_minutes: number;
                            equipment: string[];
                            exercises: {
                                exercise_id: string;
                                sets: number;
                                reps: number;
                                weight_kg: string | null;
                                weight_mode: "total" | "per_side" | "body_weight";
                                rest_seconds: number;
                            }[];
                        };
                        is_enabled: boolean;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                        updated_by: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAdminFitnessTemplatesByContentId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                content_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    content?: {
                        name: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        description: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        difficulty: "beginner" | "intermediate" | "advanced";
                        goals: {
                            zh: string[];
                            zh_hant: string[];
                            en: string[];
                        };
                        duration_minutes: number;
                        equipment: string[];
                        exercises: {
                            exercise_id: string;
                            sets: number;
                            reps: number;
                            weight_kg: string | null;
                            weight_mode: "total" | "per_side" | "body_weight";
                            rest_seconds: number;
                        }[];
                    };
                    is_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        kind: "exercise" | "template" | "plan";
                        version: number;
                        content: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            revision: number;
                            name: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            description: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            difficulty: "beginner" | "intermediate" | "advanced";
                            goals: {
                                zh: string[];
                                zh_hant: string[];
                                en: string[];
                            };
                            duration_minutes: number;
                            equipment: string[];
                            exercises: {
                                exercise_id: string;
                                sets: number;
                                reps: number;
                                weight_kg: string | null;
                                weight_mode: "total" | "per_side" | "body_weight";
                                rest_seconds: number;
                            }[];
                        };
                        is_enabled: boolean;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                        updated_by: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    listOfficialPlans: {
        parameters: {
            query?: {
                q?: string;
                page?: number;
                page_size?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: {
                            id: string;
                            kind: "exercise" | "template" | "plan";
                            version: number;
                            content: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                revision: number;
                                name: {
                                    zh: string;
                                    zh_hant: string;
                                    en: string;
                                };
                                description: {
                                    zh: string;
                                    zh_hant: string;
                                    en: string;
                                };
                                difficulty: "beginner" | "intermediate" | "advanced";
                                goals: {
                                    zh: string[];
                                    zh_hant: string[];
                                    en: string[];
                                };
                                cycle_days: number;
                                days: {
                                    day_index: number;
                                    template_id: string | null;
                                }[];
                            };
                            is_enabled: boolean;
                            /** Format: date-time */
                            created_at: string;
                            /** Format: date-time */
                            updated_at: string;
                            updated_by: string | null;
                        }[];
                        page: number;
                        page_size: number;
                        total: number;
                        next_cursor: null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAdminFitnessPlans: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    content: {
                        name: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        description: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        difficulty: "beginner" | "intermediate" | "advanced";
                        goals: {
                            zh: string[];
                            zh_hant: string[];
                            en: string[];
                        };
                        cycle_days: number;
                        days: {
                            day_index: number;
                            template_id: string | null;
                        }[];
                    };
                    is_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        kind: "exercise" | "template" | "plan";
                        version: number;
                        content: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            revision: number;
                            name: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            description: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            difficulty: "beginner" | "intermediate" | "advanced";
                            goals: {
                                zh: string[];
                                zh_hant: string[];
                                en: string[];
                            };
                            cycle_days: number;
                            days: {
                                day_index: number;
                                template_id: string | null;
                            }[];
                        };
                        is_enabled: boolean;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                        updated_by: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    patchAdminFitnessPlansByContentId: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                content_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    version: number;
                    content?: {
                        name: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        description: {
                            zh: string;
                            zh_hant: string;
                            en: string;
                        };
                        difficulty: "beginner" | "intermediate" | "advanced";
                        goals: {
                            zh: string[];
                            zh_hant: string[];
                            en: string[];
                        };
                        cycle_days: number;
                        days: {
                            day_index: number;
                            template_id: string | null;
                        }[];
                    };
                    is_enabled?: boolean;
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        kind: "exercise" | "template" | "plan";
                        version: number;
                        content: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            revision: number;
                            name: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            description: {
                                zh: string;
                                zh_hant: string;
                                en: string;
                            };
                            difficulty: "beginner" | "intermediate" | "advanced";
                            goals: {
                                zh: string[];
                                zh_hant: string[];
                                en: string[];
                            };
                            cycle_days: number;
                            days: {
                                day_index: number;
                                template_id: string | null;
                            }[];
                        };
                        is_enabled: boolean;
                        /** Format: date-time */
                        created_at: string;
                        /** Format: date-time */
                        updated_at: string;
                        updated_by: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessCatalog: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        /** @enum {number} */
                        schema_version: 1;
                        content_version: number;
                        exercises: {
                            id: string;
                            name_zh: string;
                            name_zh_hant: string;
                            name_en: string;
                            body_part: string;
                            equipment: string;
                            target: string;
                            secondary_muscles: string[];
                            instructions_zh: string[];
                            instructions_zh_hant: string[];
                            instructions_en: string[];
                            attribution: string;
                            gif_asset: string;
                            media_id?: string | null;
                            media_url: string;
                            is_enabled: boolean;
                        }[];
                        taxonomies?: {
                            body_parts: {
                                id: string;
                                name: {
                                    zh: string;
                                    zh_hant: string;
                                    en: string;
                                };
                                is_deleted: boolean;
                            }[];
                            equipment: {
                                id: string;
                                name: {
                                    zh: string;
                                    zh_hant: string;
                                    en: string;
                                };
                                is_deleted: boolean;
                            }[];
                        };
                    };
                };
            };
            /** @description Default Response */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    uploadOfficialFitnessMedia: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    filename: string;
                    data_base64: string;
                };
            };
        };
        responses: {
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        id: string;
                        url: string;
                        width: number;
                        height: number;
                        frames: number;
                        byte_size: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessMediaByMediaId: {
        parameters: {
            query?: {
                preview?: "1";
            };
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                };
            };
            /** @description Default Response */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getAdminFitnessMediaByMediaId: {
        parameters: {
            query?: {
                preview?: "1";
            };
            header?: never;
            path: {
                media_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                };
            };
            /** @description Default Response */
            304: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postFitnessSpacesByFitnessSpaceIdPlansByPlanIdCommand: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                plan_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    mutation_id: string;
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    sync_id: string;
                    base_revision: number;
                    today: string;
                    action: "save" | "generate";
                    plan?: {
                        name: string;
                        catalog_origin?: {
                            /** @enum {string} */
                            source: "official";
                            /** @example 11111111-1111-4111-8111-000000000001 */
                            item_id: string;
                            revision: number;
                        };
                        start_date: string | null;
                        status: "in_progress" | "closed";
                        cycle_days: number;
                        days: {
                            day_index: number;
                            slot: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                source_template_id: string | null;
                                name: string;
                                exercises: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    exercise_id: string;
                                    rest_seconds: number;
                                    warmup_rest_seconds: number | null;
                                    sets: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        kind: "warmup" | "working";
                                        weight: string | null;
                                        weight_left: string | null;
                                        weight_right: string | null;
                                        reps: number | null;
                                    }[];
                                }[];
                            } | null;
                        }[];
                        generation_state: {
                            next_cycle_start_date: string | null;
                            next_cycle_index: number;
                            generated_cycles: {
                                cycle_index: number;
                                start_date: string;
                                cycle_days: number;
                                generated_from_date: string;
                                rest_dates: string[];
                            }[];
                        };
                        pending_schedule: {
                            cycle_days: number;
                            days: {
                                day_index: number;
                                slot: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    source_template_id: string | null;
                                    name: string;
                                    exercises: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        exercise_id: string;
                                        rest_seconds: number;
                                        warmup_rest_seconds: number | null;
                                        sets: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            kind: "warmup" | "working";
                                            weight: string | null;
                                            weight_left: string | null;
                                            weight_right: string | null;
                                            reps: number | null;
                                        }[];
                                    }[];
                                } | null;
                            }[];
                        } | null;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        created_at: string;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                    };
                    restart_date?: string;
                    template_copies?: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        payload: {
                            name: string;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                }[];
                            }[];
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                    }[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        plan: {
                            name: string;
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            start_date: string | null;
                            status: "in_progress" | "closed";
                            cycle_days: number;
                            days: {
                                day_index: number;
                                slot: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    source_template_id: string | null;
                                    name: string;
                                    exercises: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        exercise_id: string;
                                        rest_seconds: number;
                                        warmup_rest_seconds: number | null;
                                        sets: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            kind: "warmup" | "working";
                                            weight: string | null;
                                            weight_left: string | null;
                                            weight_right: string | null;
                                            reps: number | null;
                                        }[];
                                    }[];
                                } | null;
                            }[];
                            generation_state: {
                                next_cycle_start_date: string | null;
                                next_cycle_index: number;
                                generated_cycles: {
                                    cycle_index: number;
                                    start_date: string;
                                    cycle_days: number;
                                    generated_from_date: string;
                                    rest_dates: string[];
                                }[];
                            };
                            pending_schedule: {
                                cycle_days: number;
                                days: {
                                    day_index: number;
                                    slot: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        source_template_id: string | null;
                                        name: string;
                                        exercises: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            exercise_id: string;
                                            rest_seconds: number;
                                            warmup_rest_seconds: number | null;
                                            sets: {
                                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                id: string;
                                                kind: "warmup" | "working";
                                                weight: string | null;
                                                weight_left: string | null;
                                                weight_right: string | null;
                                                reps: number | null;
                                            }[];
                                        }[];
                                    } | null;
                                }[];
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            fitness_space_id: string;
                            /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                            sync_id: string;
                            revision: number;
                            deleted_at: string | null;
                        };
                        generated_count: number;
                        removed_count: number;
                        has_more: boolean;
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdStatistics: {
        parameters: {
            query: {
                start_date: string;
                end_date: string;
                time_zone?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        training_days: number;
                        completed_workouts: number;
                        completed_sets: number;
                        total_duration_ms: number;
                        volume_kg: string;
                        by_date: {
                            date: string;
                            completed_workouts: number;
                            completed_sets: number;
                            duration_ms: number;
                            volume_kg: string;
                        }[];
                        by_exercise: {
                            exercise_id: string;
                            completed_sets: number;
                            working_sets: number;
                            volume_kg: string;
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdCalendar: {
        parameters: {
            query: {
                start_date: string;
                end_date: string;
                time_zone?: string;
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        days: {
                            date: string;
                            workouts: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                name: string;
                                status: "scheduled" | "in_progress" | "completed";
                                scheduled_date: string;
                                workout_date: string;
                                source_plan_id: string | null;
                                source_plan_name: string | null;
                                revision: number;
                            }[];
                            rest_days: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                source_plan_id: string;
                                source_plan_name: string;
                            }[];
                        }[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdWorkoutsByWorkoutId: {
        parameters: {
            query?: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                workout_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        name: string;
                        scheduled_date: string;
                        source_kind: "blank" | "template" | "plan";
                        source_plan_id: string | null;
                        source_plan_name: string | null;
                        source_template_id: string | null;
                        occurrence_key: string | null;
                        exercises: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            exercise_id: string;
                            rest_seconds: number;
                            warmup_rest_seconds: number | null;
                            sets: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                kind: "warmup" | "working";
                                weight: string | null;
                                weight_left: string | null;
                                weight_right: string | null;
                                reps: number | null;
                                completed: boolean;
                                rest_durations_seconds?: number[];
                            }[];
                        }[];
                        status: "scheduled" | "in_progress" | "completed";
                        run_segments: {
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            started_at: string;
                            ended_at: string | null;
                        }[];
                        rest_timer: {
                            status: "running" | "paused";
                            ends_at: string | null;
                            remaining_seconds: number;
                            duration_seconds: number;
                            elapsed_seconds?: number;
                            exercise_id?: string | null;
                            set_id?: string | null;
                        } | null;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        created_at: string;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        updated_at: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        fitness_space_id: string;
                        /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                        sync_id: string;
                        revision: number;
                        deleted_at: string | null;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getFitnessSpacesByFitnessSpaceIdExport: {
        parameters: {
            query?: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                sync_id?: string;
            };
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        records: ({
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @enum {string} */
                            entity_type: "fitness_template";
                            payload: {
                                name: string;
                                exercises: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    exercise_id: string;
                                    rest_seconds: number;
                                    warmup_rest_seconds: number | null;
                                    sets: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        kind: "warmup" | "working";
                                        weight: string | null;
                                        weight_left: string | null;
                                        weight_right: string | null;
                                        reps: number | null;
                                    }[];
                                }[];
                                catalog_origin?: {
                                    /** @enum {string} */
                                    source: "official";
                                    /** @example 11111111-1111-4111-8111-000000000001 */
                                    item_id: string;
                                    revision: number;
                                };
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                created_at: string;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                updated_at: string;
                            };
                        } | {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @enum {string} */
                            entity_type: "fitness_plan";
                            payload: {
                                name: string;
                                catalog_origin?: {
                                    /** @enum {string} */
                                    source: "official";
                                    /** @example 11111111-1111-4111-8111-000000000001 */
                                    item_id: string;
                                    revision: number;
                                };
                                start_date: string | null;
                                status: "in_progress" | "closed";
                                cycle_days: number;
                                days: {
                                    day_index: number;
                                    slot: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        source_template_id: string | null;
                                        name: string;
                                        exercises: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            exercise_id: string;
                                            rest_seconds: number;
                                            warmup_rest_seconds: number | null;
                                            sets: {
                                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                id: string;
                                                kind: "warmup" | "working";
                                                weight: string | null;
                                                weight_left: string | null;
                                                weight_right: string | null;
                                                reps: number | null;
                                            }[];
                                        }[];
                                    } | null;
                                }[];
                                generation_state: {
                                    next_cycle_start_date: string | null;
                                    next_cycle_index: number;
                                    generated_cycles: {
                                        cycle_index: number;
                                        start_date: string;
                                        cycle_days: number;
                                        generated_from_date: string;
                                        rest_dates: string[];
                                    }[];
                                };
                                pending_schedule: {
                                    cycle_days: number;
                                    days: {
                                        day_index: number;
                                        slot: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            source_template_id: string | null;
                                            name: string;
                                            exercises: {
                                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                id: string;
                                                exercise_id: string;
                                                rest_seconds: number;
                                                warmup_rest_seconds: number | null;
                                                sets: {
                                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                    id: string;
                                                    kind: "warmup" | "working";
                                                    weight: string | null;
                                                    weight_left: string | null;
                                                    weight_right: string | null;
                                                    reps: number | null;
                                                }[];
                                            }[];
                                        } | null;
                                    }[];
                                } | null;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                created_at: string;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                updated_at: string;
                            };
                        } | {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @enum {string} */
                            entity_type: "fitness_workout";
                            payload: {
                                name: string;
                                scheduled_date: string;
                                source_kind: "blank" | "template" | "plan";
                                source_plan_id: string | null;
                                source_plan_name: string | null;
                                source_template_id: string | null;
                                occurrence_key: string | null;
                                exercises: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    exercise_id: string;
                                    rest_seconds: number;
                                    warmup_rest_seconds: number | null;
                                    sets: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        kind: "warmup" | "working";
                                        weight: string | null;
                                        weight_left: string | null;
                                        weight_right: string | null;
                                        reps: number | null;
                                        completed: boolean;
                                        rest_durations_seconds?: number[];
                                    }[];
                                }[];
                                status: "scheduled" | "in_progress" | "completed";
                                run_segments: {
                                    /**
                                     * Format: date-time
                                     * @example 2026-08-20T09:00:00.000Z
                                     */
                                    started_at: string;
                                    ended_at: string | null;
                                }[];
                                rest_timer: {
                                    status: "running" | "paused";
                                    ends_at: string | null;
                                    remaining_seconds: number;
                                    duration_seconds: number;
                                    elapsed_seconds?: number;
                                    exercise_id?: string | null;
                                    set_id?: string | null;
                                } | null;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                created_at: string;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                updated_at: string;
                            };
                        } | {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            id: string;
                            /** @enum {string} */
                            entity_type: "fitness_preferences";
                            payload: {
                                custom_exercises: {
                                    id: string;
                                    name: string;
                                    body_part: string;
                                    equipment: string;
                                    icon: string;
                                    image: string | null;
                                    deleted: boolean;
                                }[];
                                default_rest_seconds: number;
                                default_warmup_rest_seconds?: number;
                                exercise_rest_settings?: {
                                    [key: string]: {
                                        rest_seconds: number;
                                        warmup_rest_seconds: number;
                                    };
                                };
                                sound_enabled: boolean;
                                vibration_enabled: boolean;
                                pinned_exercise_ids: string[];
                                exercise_weight_modes: {
                                    [key: string]: boolean;
                                };
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                created_at: string;
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                updated_at: string;
                            };
                        })[];
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postFitnessSpacesByFitnessSpaceIdImport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                fitness_space_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    sync_id: string;
                    /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                    export_id: string;
                    replace_preferences?: boolean;
                    records: ({
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        /** @enum {string} */
                        entity_type: "fitness_template";
                        payload: {
                            name: string;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                }[];
                            }[];
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        /** @enum {string} */
                        entity_type: "fitness_plan";
                        payload: {
                            name: string;
                            catalog_origin?: {
                                /** @enum {string} */
                                source: "official";
                                /** @example 11111111-1111-4111-8111-000000000001 */
                                item_id: string;
                                revision: number;
                            };
                            start_date: string | null;
                            status: "in_progress" | "closed";
                            cycle_days: number;
                            days: {
                                day_index: number;
                                slot: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    source_template_id: string | null;
                                    name: string;
                                    exercises: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        exercise_id: string;
                                        rest_seconds: number;
                                        warmup_rest_seconds: number | null;
                                        sets: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            kind: "warmup" | "working";
                                            weight: string | null;
                                            weight_left: string | null;
                                            weight_right: string | null;
                                            reps: number | null;
                                        }[];
                                    }[];
                                } | null;
                            }[];
                            generation_state: {
                                next_cycle_start_date: string | null;
                                next_cycle_index: number;
                                generated_cycles: {
                                    cycle_index: number;
                                    start_date: string;
                                    cycle_days: number;
                                    generated_from_date: string;
                                    rest_dates: string[];
                                }[];
                            };
                            pending_schedule: {
                                cycle_days: number;
                                days: {
                                    day_index: number;
                                    slot: {
                                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                        id: string;
                                        source_template_id: string | null;
                                        name: string;
                                        exercises: {
                                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                            id: string;
                                            exercise_id: string;
                                            rest_seconds: number;
                                            warmup_rest_seconds: number | null;
                                            sets: {
                                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                                id: string;
                                                kind: "warmup" | "working";
                                                weight: string | null;
                                                weight_left: string | null;
                                                weight_right: string | null;
                                                reps: number | null;
                                            }[];
                                        }[];
                                    } | null;
                                }[];
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        /** @enum {string} */
                        entity_type: "fitness_workout";
                        payload: {
                            name: string;
                            scheduled_date: string;
                            source_kind: "blank" | "template" | "plan";
                            source_plan_id: string | null;
                            source_plan_name: string | null;
                            source_template_id: string | null;
                            occurrence_key: string | null;
                            exercises: {
                                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                id: string;
                                exercise_id: string;
                                rest_seconds: number;
                                warmup_rest_seconds: number | null;
                                sets: {
                                    /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                                    id: string;
                                    kind: "warmup" | "working";
                                    weight: string | null;
                                    weight_left: string | null;
                                    weight_right: string | null;
                                    reps: number | null;
                                    completed: boolean;
                                    rest_durations_seconds?: number[];
                                }[];
                            }[];
                            status: "scheduled" | "in_progress" | "completed";
                            run_segments: {
                                /**
                                 * Format: date-time
                                 * @example 2026-08-20T09:00:00.000Z
                                 */
                                started_at: string;
                                ended_at: string | null;
                            }[];
                            rest_timer: {
                                status: "running" | "paused";
                                ends_at: string | null;
                                remaining_seconds: number;
                                duration_seconds: number;
                                elapsed_seconds?: number;
                                exercise_id?: string | null;
                                set_id?: string | null;
                            } | null;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                    } | {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id: string;
                        /** @enum {string} */
                        entity_type: "fitness_preferences";
                        payload: {
                            custom_exercises: {
                                id: string;
                                name: string;
                                body_part: string;
                                equipment: string;
                                icon: string;
                                image: string | null;
                                deleted: boolean;
                            }[];
                            default_rest_seconds: number;
                            default_warmup_rest_seconds?: number;
                            exercise_rest_settings?: {
                                [key: string]: {
                                    rest_seconds: number;
                                    warmup_rest_seconds: number;
                                };
                            };
                            sound_enabled: boolean;
                            vibration_enabled: boolean;
                            pinned_exercise_ids: string[];
                            exercise_weight_modes: {
                                [key: string]: boolean;
                            };
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            created_at: string;
                            /**
                             * Format: date-time
                             * @example 2026-08-20T09:00:00.000Z
                             */
                            updated_at: string;
                        };
                    })[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        imported: number;
                        skipped: number;
                        ids: {
                            [key: string]: string;
                        };
                        replayed: boolean;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postLedgersByLedgerIdImports: {
        parameters: {
            query: {
                /** @example 018f7f95-4b8a-4f5e-8d0c-2ebf4682c761 */
                expected_sync_id: string;
                expected_currency: string;
                require_unarchived: boolean;
            };
            header?: {
                "idempotency-key"?: string;
            };
            path: {
                /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                ledger_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    categories?: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id?: string;
                        name: string;
                        /** @enum {string} */
                        kind: "expense";
                        level: 1 | 2;
                        sort_order?: number;
                        icon?: string | null;
                        parent_id?: string | null;
                    }[];
                    transactions?: {
                        /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                        id?: string;
                        /** @enum {string} */
                        tx_type: "expense";
                        amount: string;
                        /**
                         * Format: date-time
                         * @example 2026-08-20T09:00:00.000Z
                         */
                        happened_at: string;
                        note?: string | null;
                        category_id?: string | null;
                        currency_code: string;
                        native_amount: string;
                        recurring_id?: string | null;
                        occurrence_date?: string | null;
                        payer_member_id?: string | null;
                        aa_mode?: "0" | "1" | "2" | null;
                        splits?: {
                            /** @example 056cf10d-2d59-599c-9d97-6749e866aa52 */
                            member_id: string;
                            amount: string;
                        }[] | null;
                        base_revision?: number;
                    }[];
                };
            };
        };
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        imported_categories: number;
                        imported_transactions: number;
                    };
                };
            };
            /** @description Default Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        imported_categories: number;
                        imported_transactions: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postWsTicket: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Default Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        ticket: string;
                        expires_in: number;
                    };
                };
            };
            /** @description Default Response */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description 请求频率超过限制，请按 Retry-After 指示重试。 */
            429: {
                headers: {
                    /** @description 距离允许重试的秒数 */
                    "Retry-After"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            /** @description Default Response */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
}
