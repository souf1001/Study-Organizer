// Matches a Moodle course to one of the user's modules by code or name.
import type { Module } from './types'

export function matchCourseToModules(
  course: { id: number; fullname: string; shortname?: string },
  modules: Module[],
): Module | null {
  if (modules.length === 0) return null
  /** Strips semester tags and course-type words so only the subject name remains */
  const clean = (text: string) =>
    text
      .toLowerCase()
      .replace(/\b(?:ws|wise|sose|ss)\s*\d{2}(?:\/\d{2})?\b/gi, '')
      .replace(
        /\b(?:vorlesung|übung|uebung|praktikum|integrierte veranstaltung|vl|ue|pr|iv)\b/gi,
        '',
      )
      .replace(/[^a-z0-9äöüß]+/gi, ' ')
      .trim()

  const courseFullName = clean(course.fullname)
  const courseShortName = clean(course.shortname || '')

  // 1. Exact match by module code
  for (const m of modules) {
    if (m.code && m.code.trim().length >= 2) {
      const moduleCode = clean(m.code)
      if (
        (moduleCode && (courseShortName === moduleCode || courseFullName.includes(moduleCode))) ||
        (course.shortname && course.shortname.toLowerCase().includes(m.code.trim().toLowerCase()))
      ) {
        return m
      }
    }
  }

  // 2. Exact match by module name
  for (const m of modules) {
    const moduleName = clean(m.name)
    if (moduleName && (courseFullName === moduleName || courseShortName === moduleName)) {
      return m
    }
  }

  // 3. Substring match: the module name is contained in the course name (or vice versa); longest wins
  let bestMatch: Module | null = null
  let bestMatchLength = 0

  for (const m of modules) {
    const moduleName = clean(m.name)
    if (moduleName.length < 4) continue
    if (
      courseFullName.includes(moduleName) ||
      (courseShortName && courseShortName.includes(moduleName))
    ) {
      if (moduleName.length > bestMatchLength) {
        bestMatch = m
        bestMatchLength = moduleName.length
      }
    } else if (
      moduleName.length >= 6 &&
      courseFullName.length >= 6 &&
      moduleName.includes(courseFullName)
    ) {
      if (courseFullName.length > bestMatchLength) {
        bestMatch = m
        bestMatchLength = courseFullName.length
      }
    }
  }

  return bestMatch
}
