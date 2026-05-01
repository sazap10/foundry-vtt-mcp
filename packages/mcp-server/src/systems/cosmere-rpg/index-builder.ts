/**
 * Cosmere RPG Index Builder
 *
 * Builds the enhanced creature index from Foundry compendium packs.
 *
 * Runs in Foundry's browser context (foundry-module side); does NOT execute
 * on the Node MCP server. The mcp-server-side `CosmereRpgAdapter` re-uses
 * `extractCreatureData` for any places it needs the same logic on already-
 * loaded actor data.
 *
 * Schema reference: github.com/the-metalworks/cosmere-rpg
 *   - Adversary actors expose `system.tier`, `system.role`, defenses,
 *     resources, etc. — see ../filters.ts for the indexed field list.
 */

import type { IndexBuilder, CosmereRpgCreatureIndex } from '../types.js';
import { readDerived } from './constants.js';

declare const ui: any;

interface CosmereExtractionResult {
  creature: CosmereRpgCreatureIndex;
  errors: number;
}

export class CosmereRpgIndexBuilder implements IndexBuilder {
  private moduleId: string;

  constructor(moduleId: string = 'foundry-mcp-bridge') {
    this.moduleId = moduleId;
  }

  getSystemId() {
    return 'cosmere-rpg' as const;
  }

  async buildIndex(packs: any[], _force = false): Promise<CosmereRpgCreatureIndex[]> {
    const startTime = Date.now();
    let progressNotification: any = null;
    let totalErrors = 0;

    try {
      const actorPacks = packs.filter((pack) => pack.metadata.type === 'Actor');
      const enhancedCreatures: CosmereRpgCreatureIndex[] = [];

      console.log(
        `[${this.moduleId}] Starting Cosmere RPG creature index build from ${actorPacks.length} packs...`,
      );
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.info(
          `Starting Cosmere RPG creature index build from ${actorPacks.length} packs...`,
        );
      }

      for (let i = 0; i < actorPacks.length; i++) {
        const pack = actorPacks[i];
        const progressPercent = Math.round((i / actorPacks.length) * 100);

        if (i % 3 === 0 || pack.metadata.label.toLowerCase().includes('adversar')) {
          if (progressNotification && typeof ui !== 'undefined') {
            progressNotification.remove();
          }
          if (typeof ui !== 'undefined' && ui.notifications) {
            progressNotification = ui.notifications.info(
              `Building creature index... ${progressPercent}% (${i + 1}/${actorPacks.length}) Processing: ${pack.metadata.label}`,
            );
          }
        }

        try {
          if (!pack.indexed) {
            await pack.getIndex({});
          }

          const packResult = await this.extractDataFromPack(pack);
          enhancedCreatures.push(...packResult.creatures);
          totalErrors += packResult.errors;

          if (i === 0 || (i + 1) % 5 === 0 || i === actorPacks.length - 1) {
            const totalCreaturesSoFar = enhancedCreatures.length;
            if (progressNotification && typeof ui !== 'undefined') {
              progressNotification.remove();
            }
            if (typeof ui !== 'undefined' && ui.notifications) {
              progressNotification = ui.notifications.info(
                `Index Progress: ${i + 1}/${actorPacks.length} packs complete, ${totalCreaturesSoFar} creatures indexed`,
              );
            }
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to process pack ${pack.metadata.label}:`,
            error,
          );
          if (typeof ui !== 'undefined' && ui.notifications) {
            ui.notifications.warn(
              `Warning: Failed to index pack "${pack.metadata.label}" - continuing with other packs`,
            );
          }
        }
      }

      if (progressNotification && typeof ui !== 'undefined') {
        progressNotification.remove();
      }

      const buildTimeSeconds = Math.round((Date.now() - startTime) / 1000);
      const errorText = totalErrors > 0 ? ` (${totalErrors} extraction errors)` : '';
      const successMessage = `Cosmere RPG creature index complete! ${enhancedCreatures.length} creatures indexed from ${actorPacks.length} packs in ${buildTimeSeconds}s${errorText}`;

      console.log(`[${this.moduleId}] ${successMessage}`);
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.info(successMessage);
      }

      return enhancedCreatures;
    } catch (error) {
      if (progressNotification && typeof ui !== 'undefined') {
        progressNotification.remove();
      }

      const errorMessage = `Failed to build Cosmere RPG creature index: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`;
      console.error(`[${this.moduleId}] ${errorMessage}`);
      if (typeof ui !== 'undefined' && ui.notifications) {
        ui.notifications.error(errorMessage);
      }
      throw error;
    }
  }

  async extractDataFromPack(
    pack: any,
  ): Promise<{ creatures: CosmereRpgCreatureIndex[]; errors: number }> {
    const creatures: CosmereRpgCreatureIndex[] = [];
    let errors = 0;

    try {
      const documents = await pack.getDocuments();

      for (const doc of documents) {
        try {
          // Cosmere-rpg compendium creatures are `adversary`-typed. Player
          // characters (`character`) are excluded from the creature index
          // — they're individual sheets, not encounter material.
          if (doc.type !== 'adversary') {
            continue;
          }

          const result = this.extractCreatureData(doc, pack);
          if (result) {
            creatures.push(result.creature);
            errors += result.errors;
          }
        } catch (error) {
          console.warn(
            `[${this.moduleId}] Failed to extract Cosmere RPG data from ${doc.name} in ${pack.metadata.label}:`,
            error,
          );
          errors++;
        }
      }
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to load documents from ${pack.metadata.label}:`,
        error,
      );
      errors++;
    }

    return { creatures, errors };
  }

  /**
   * Extract a single Cosmere RPG creature.
   *
   * Reads the live (post-derive) `doc.system` block. DerivedValueField
   * fields (resources.*.max, defenses.*, deflect, movement.*.rate) are
   * resolved via `readDerived`, which honours `useOverride`.
   */
  extractCreatureData(doc: any, pack: any): CosmereExtractionResult | null {
    try {
      const system = doc.system ?? {};

      const tier = typeof system.tier === 'number' ? system.tier : undefined;
      const level = typeof system.level === 'number' ? system.level : undefined;

      const role =
        typeof system.role === 'string' && system.role.length > 0
          ? system.role.toLowerCase()
          : undefined;

      const size =
        typeof system.size === 'string' && system.size.length > 0
          ? system.size.toLowerCase()
          : undefined;

      const creatureType =
        typeof system.type?.id === 'string' && system.type.id.length > 0
          ? system.type.id.toLowerCase()
          : undefined;

      const subtype =
        typeof system.type?.subtype === 'string' && system.type.subtype.length > 0
          ? system.type.subtype
          : undefined;

      const health = readDerived(system.resources?.hea?.max);
      const focus = readDerived(system.resources?.foc?.max);
      const investiture = readDerived(system.resources?.inv?.max) ?? 0;

      let defenses: { phy?: number; cog?: number; spi?: number } | undefined;
      if (system.defenses) {
        defenses = {};
        const phy = readDerived(system.defenses.phy);
        const cog = readDerived(system.defenses.cog);
        const spi = readDerived(system.defenses.spi);
        if (phy !== undefined) defenses.phy = phy;
        if (cog !== undefined) defenses.cog = cog;
        if (spi !== undefined) defenses.spi = spi;
      }

      const deflect = readDerived(system.deflect);
      const walkSpeed = readDerived(system.movement?.walk?.rate);

      // Build systemData incrementally so undefined fields stay omitted
      // (the type uses `exactOptionalPropertyTypes`).
      const systemData: CosmereRpgCreatureIndex['systemData'] = {
        hasInvestiture: investiture > 0,
        investiture,
      };
      if (level !== undefined) systemData.level = level;
      if (tier !== undefined) systemData.tier = tier;
      if (role !== undefined) systemData.role = role;
      if (size !== undefined) systemData.size = size;
      if (creatureType !== undefined) systemData.creatureType = creatureType;
      if (subtype !== undefined) systemData.subtype = subtype;
      if (health !== undefined) systemData.health = health;
      if (focus !== undefined) systemData.focus = focus;
      if (defenses !== undefined) systemData.defenses = defenses;
      if (deflect !== undefined) systemData.deflect = deflect;
      if (walkSpeed !== undefined) systemData.walkSpeed = walkSpeed;

      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          packName: pack.metadata.id,
          packLabel: pack.metadata.label,
          img: doc.img,
          system: 'cosmere-rpg',
          systemData,
        },
        errors: 0,
      };
    } catch (error) {
      console.warn(
        `[${this.moduleId}] Failed to extract Cosmere RPG data from ${doc.name}:`,
        error,
      );

      // Minimal fallback so the index isn't gappy on a single bad doc.
      return {
        creature: {
          id: doc._id,
          name: doc.name,
          type: doc.type,
          packName: pack.metadata.id,
          packLabel: pack.metadata.label,
          img: doc.img,
          system: 'cosmere-rpg',
          systemData: {
            investiture: 0,
            hasInvestiture: false,
          },
        },
        errors: 1,
      };
    }
  }
}
