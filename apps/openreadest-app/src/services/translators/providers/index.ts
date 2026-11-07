import { TranslationProvider } from '../types';
import { azureProvider } from './azure';
import { googleProvider } from './google';
import { yandexProvider } from './yandex';
import { localDictionaryProvider } from './localDictionary';

function createTranslator<T extends string>(
  name: T,
  implementation: TranslationProvider,
): TranslationProvider & { name: T } {
  if (name !== implementation.name) {
    throw Error(
      `Translator name "${name}" does not match implementation name "${implementation.name}"`,
    );
  }
  return implementation as TranslationProvider & { name: T };
}

const azureTranslator = createTranslator('azure', azureProvider);
const googleTranslator = createTranslator('google', googleProvider);
const yandexTranslator = createTranslator('yandex', yandexProvider);
// 放在末尾：默认翻译服务仍是原来的在线服务，只有用户主动在下拉里选择
// 「本地词典（离线）」才会走纯本地查词，不影响既有行为。
const localDictionaryTranslator = createTranslator('local-dictionary', localDictionaryProvider);

const availableTranslators = [
  azureTranslator,
  googleTranslator,
  yandexTranslator,
  localDictionaryTranslator,
  // Add more translators here
];

export type TranslatorName = (typeof availableTranslators)[number]['name'];

export const getTranslator = (name: TranslatorName): TranslationProvider | undefined => {
  return availableTranslators.find((translator) => translator.name === name);
};

export const getTranslators = (): TranslationProvider[] => {
  return availableTranslators;
};
