// apps/web/src/i18n/index.ts
import { ar } from './ar.js';
import { en } from './en.js';

export type Locale = 'ar' | 'en';
export type TranslationKey = keyof typeof ar;

const translations = { ar, en } as const;

export function getTranslations(locale: Locale) {
  return translations[locale] ?? translations.ar;
}

export function t(key: TranslationKey, locale: Locale = 'ar', vars?: Record<string, string>): string {
  const dict = getTranslations(locale);
  let str = (dict as Record<string, string>)[key] ?? (ar as Record<string, string>)[key] ?? key;
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      str = str.replace(`{${k}}`, v);
    });
  }
  return str;
}

export function getLocaleFromCookie(cookies: string): Locale {
  const match = cookies.match(/locale=([a-z]{2})/);
  return (match?.[1] as Locale) ?? 'ar';
}

export function isRTL(locale: Locale): boolean {
  return locale === 'ar';
}

export { ar, en };
