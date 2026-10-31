export interface LegacyUser {
    readonly id: string;
    readonly displayName: string;
}

export function normalizeName(name: string): string {
    return name.trim();
}
