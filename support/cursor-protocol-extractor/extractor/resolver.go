// resolver.go resolves local symbols, module aliases, and export aliases in minified bundles.
package main

import (
	"regexp"
	"sort"
	"strings"
)

// newTypeResolver builds a unified index of messages, enums, and module aliases.
func newTypeResolver(messages []Message, enums []Enum, aliases aliasIndex, exportAliases aliasIndex) *TypeResolver {
	resolver := &TypeResolver{
		bySymbol: make(map[string][]symbolDef),
		byAlias:  make(map[string][]symbolDef),
		byShort:  make(map[string][]symbolDef),
	}

	add := func(symbol, typeName string, pos int, moduleStart int, kind string) {
		symbol = strings.TrimSpace(symbol)
		typeName = strings.TrimSpace(typeName)
		if symbol == "" || typeName == "" {
			return
		}
		def := symbolDef{TypeName: typeName, Pos: pos, ModuleStart: moduleStart, Kind: kind}
		resolver.bySymbol[symbol] = append(resolver.bySymbol[symbol], def)
		_, shortName := parseTypeName(typeName)
		if shortName != "" {
			resolver.byShort[shortName] = append(resolver.byShort[shortName], def)
			underscoreAlias := strings.ReplaceAll(shortName, ".", "_")
			if underscoreAlias != shortName {
				resolver.byShort[underscoreAlias] = append(resolver.byShort[underscoreAlias], def)
			}
			if idx := strings.LastIndex(shortName, "."); idx > 0 && idx+1 < len(shortName) {
				resolver.byShort[shortName[idx+1:]] = append(resolver.byShort[shortName[idx+1:]], def)
			}
			if idx := strings.LastIndex(underscoreAlias, "_"); idx > 0 && idx+1 < len(underscoreAlias) {
				resolver.byShort[underscoreAlias[idx+1:]] = append(resolver.byShort[underscoreAlias[idx+1:]], def)
			}
		}
	}
	addAlias := func(symbol, typeName string, pos int, moduleStart int, kind string) {
		symbol = strings.TrimSpace(symbol)
		typeName = strings.TrimSpace(typeName)
		if symbol == "" || typeName == "" {
			return
		}
		resolver.byAlias[symbol] = append(resolver.byAlias[symbol], symbolDef{
			TypeName: typeName, Pos: pos, ModuleStart: moduleStart, Kind: kind,
		})
	}

	for _, msg := range messages {
		add(msg.VarName, msg.TypeName, msg.Pos, msg.ModuleStart, "message")
		if msg.InternalName != "" && msg.InternalName != msg.VarName {
			add(msg.InternalName, msg.TypeName, msg.Pos, msg.ModuleStart, "message")
		}
		for _, alias := range aliasesForSymbols(aliases[msg.ModuleStart], msg.VarName, msg.InternalName) {
			addAlias(alias, msg.TypeName, msg.Pos, msg.ModuleStart, "message")
		}
	}
	for _, enum := range enums {
		add(enum.VarName, enum.TypeName, enum.Pos, enum.ModuleStart, "enum")
		for _, alias := range aliasesForSymbols(aliases[enum.ModuleStart], enum.VarName) {
			addAlias(alias, enum.TypeName, enum.Pos, enum.ModuleStart, "enum")
		}
	}

	for _, msg := range messages {
		for _, alias := range aliasesForSymbols(exportAliases[msg.ModuleStart], msg.VarName, msg.InternalName) {
			addAlias(alias, msg.TypeName, msg.Pos, msg.ModuleStart, "message")
		}
	}
	for _, enum := range enums {
		for _, alias := range aliasesForSymbols(exportAliases[enum.ModuleStart], enum.VarName) {
			addAlias(alias, enum.TypeName, enum.Pos, enum.ModuleStart, "enum")
		}
	}

	return resolver
}

// buildAliasIndex extracts local aliases formed by variable declarations and assignments.
func buildAliasIndex(text string, moduleStarts []int) aliasIndex {
	directByModule := make(map[int]map[string]string)
	addMatches := func(matches [][]int) {
		for _, match := range matches {
			alias := strings.TrimSpace(text[match[2]:match[3]])
			target := strings.TrimSpace(text[match[4]:match[5]])
			if alias == "" || target == "" || alias == target {
				continue
			}
			moduleStart := moduleStartForPos(moduleStarts, match[0])
			if directByModule[moduleStart] == nil {
				directByModule[moduleStart] = make(map[string]string)
			}
			directByModule[moduleStart][alias] = target
		}
	}

	addMatches(varAliasRe.FindAllStringSubmatchIndex(text, -1))
	addMatches(assignmentAliasRe.FindAllStringSubmatchIndex(text, -1))

	resolveRoot := func(direct map[string]string, symbol string) string {
		seen := make(map[string]bool)
		current := symbol
		for {
			if seen[current] {
				return symbol
			}
			seen[current] = true
			next := direct[current]
			if next == "" {
				return current
			}
			current = next
		}
	}

	aliasSets := make(map[int]map[string]map[string]bool)
	addAlias := func(moduleStart int, root string, alias string) {
		root = strings.TrimSpace(root)
		alias = strings.TrimSpace(alias)
		if root == "" || alias == "" || root == alias {
			return
		}
		if aliasSets[moduleStart] == nil {
			aliasSets[moduleStart] = make(map[string]map[string]bool)
		}
		if aliasSets[moduleStart][root] == nil {
			aliasSets[moduleStart][root] = make(map[string]bool)
		}
		aliasSets[moduleStart][root][alias] = true
	}

	for moduleStart, direct := range directByModule {
		for alias := range direct {
			root := resolveRoot(direct, alias)
			addAlias(moduleStart, root, alias)
		}
	}

	if len(aliasSets) == 0 {
		return nil
	}
	aliases := make(aliasIndex, len(aliasSets))
	for moduleStart, roots := range aliasSets {
		aliases[moduleStart] = make(map[string][]string, len(roots))
		for root, set := range roots {
			for alias := range set {
				aliases[moduleStart][root] = append(aliases[moduleStart][root], alias)
			}
			sort.Strings(aliases[moduleStart][root])
		}
	}
	return aliases
}

// buildWebpackExportAliasIndex extracts symbol aliases from Webpack export tables.
func buildWebpackExportAliasIndex(text string, moduleStarts []int) aliasIndex {
	aliasSets := make(map[int]map[string]map[string]bool)
	addAlias := func(moduleStart int, root string, alias string) {
		root = strings.TrimSpace(root)
		alias = strings.TrimSpace(alias)
		if root == "" || alias == "" || root == alias {
			return
		}
		if aliasSets[moduleStart] == nil {
			aliasSets[moduleStart] = make(map[string]map[string]bool)
		}
		if aliasSets[moduleStart][root] == nil {
			aliasSets[moduleStart][root] = make(map[string]bool)
		}
		aliasSets[moduleStart][root][alias] = true
	}

	// Webpack exposes members via n.d(t, { KS: () => T }); services use r.KS while message definitions use the local symbol T.
	for _, blockMatch := range webpackExportBlockRe.FindAllStringIndex(text, -1) {
		moduleStart := moduleStartForPos(moduleStarts, blockMatch[0])
		blockStart := blockMatch[1] - 1
		blockEnd := findMatchingBrace(text, blockStart)
		if blockEnd == -1 {
			continue
		}
		block := text[blockStart:blockEnd]
		for _, entry := range webpackExportEntryRe.FindAllStringSubmatch(block, -1) {
			addAlias(moduleStart, entry[2], entry[1])
		}
	}

	if len(aliasSets) == 0 {
		return nil
	}
	aliases := make(aliasIndex, len(aliasSets))
	for moduleStart, roots := range aliasSets {
		aliases[moduleStart] = make(map[string][]string, len(roots))
		for root, set := range roots {
			for alias := range set {
				aliases[moduleStart][root] = append(aliases[moduleStart][root], alias)
			}
			sort.Strings(aliases[moduleStart][root])
		}
	}
	return aliases
}

// aliasesForSymbols returns deduplicated aliases for a set of target symbols.
func aliasesForSymbols(aliases map[string][]string, symbols ...string) []string {
	if len(aliases) == 0 {
		return nil
	}
	seen := make(map[string]bool)
	var result []string
	for _, symbol := range symbols {
		for _, alias := range aliases[strings.TrimSpace(symbol)] {
			if alias == "" || seen[alias] {
				continue
			}
			seen[alias] = true
			result = append(result, alias)
		}
	}
	sort.Strings(result)
	return result
}

// looksLikeFullTypeName reports whether a reference is already a fully qualified protocol type name.
func looksLikeFullTypeName(ref string) bool {
	trimmed := strings.TrimSpace(ref)
	if strings.HasPrefix(trimmed, "google.protobuf.") || strings.HasPrefix(trimmed, "google.rpc.") {
		return true
	}
	matched, _ := regexp.MatchString(`^[\w.]+\.v\d+\.[\w.]+$`, trimmed)
	return matched
}

// pickBestDefinition chooses a definition by module, kind, preferred package, and source distance.
func pickBestDefinition(candidates []symbolDef, contextPos int, contextModuleStart int, preferredPkg string, expectedKind string) (symbolDef, bool) {
	if len(candidates) == 0 {
		return symbolDef{}, false
	}

	filtered := candidates
	if strings.TrimSpace(expectedKind) != "" {
		tmp := make([]symbolDef, 0, len(candidates))
		for _, item := range candidates {
			if item.Kind == expectedKind {
				tmp = append(tmp, item)
			}
		}
		if len(tmp) > 0 {
			filtered = tmp
		}
	}

	if strings.TrimSpace(preferredPkg) != "" {
		tmp := make([]symbolDef, 0, len(filtered))
		for _, item := range filtered {
			pkg, _ := parseTypeName(item.TypeName)
			if pkg == preferredPkg {
				tmp = append(tmp, item)
			}
		}
		if len(tmp) > 0 {
			filtered = tmp
		}
	}

	if contextModuleStart > 0 {
		tmp := make([]symbolDef, 0, len(filtered))
		for _, item := range filtered {
			if item.ModuleStart == contextModuleStart {
				tmp = append(tmp, item)
			}
		}
		if len(tmp) > 0 {
			filtered = tmp
		}
	}

	// Pick the definition with the smallest absolute distance; ties prefer forward definitions.
	bestIndex := -1
	bestDistance := 0
	bestIsFuture := false
	for index, item := range filtered {
		distance := absInt(item.Pos - contextPos)
		isFuture := item.Pos > contextPos
		if bestIndex == -1 {
			bestIndex = index
			bestDistance = distance
			bestIsFuture = isFuture
			continue
		}
		if distance < bestDistance {
			bestIndex = index
			bestDistance = distance
			bestIsFuture = isFuture
			continue
		}
		if distance == bestDistance {
			// Ties prefer definitions earlier than the current position.
			if bestIsFuture && !isFuture {
				bestIndex = index
				bestIsFuture = isFuture
			}
		}
	}
	if bestIndex < 0 {
		return symbolDef{}, false
	}
	return filtered[bestIndex], true
}

// ResolveTypeName resolves a local variable, alias, or short name into a fully qualified type name.
func (resolver *TypeResolver) ResolveTypeName(ref string, contextPos int, contextModuleStart int, preferredPkg string, expectedKind string) (string, bool) {
	if resolver == nil {
		return "", false
	}

	trimmed := strings.TrimSpace(ref)
	if trimmed == "" {
		return "", false
	}
	if looksLikeFullTypeName(trimmed) {
		return trimmed, true
	}

	resolveBySymbol := func(symbol string, preferSameModule bool) (string, bool) {
		candidates := resolver.bySymbol[symbol]
		if len(candidates) == 0 {
			return "", false
		}
		moduleStart := 0
		if preferSameModule {
			moduleStart = contextModuleStart
		}
		best, ok := pickBestDefinition(candidates, contextPos, moduleStart, preferredPkg, expectedKind)
		if !ok {
			return "", false
		}
		return best.TypeName, true
	}
	resolveByAlias := func(symbol string, targetModuleStart int) (string, bool) {
		candidates := resolver.byAlias[symbol]
		if len(candidates) == 0 {
			return "", false
		}
		best, ok := pickBestDefinition(candidates, contextPos, targetModuleStart, preferredPkg, expectedKind)
		if !ok {
			return "", false
		}
		return best.TypeName, true
	}
	resolveByShort := func(symbol string, preferSameModule bool) (string, bool) {
		candidates := resolver.byShort[symbol]
		if len(candidates) == 0 {
			return "", false
		}
		moduleStart := 0
		if preferSameModule {
			moduleStart = contextModuleStart
		}
		best, ok := pickBestDefinition(candidates, contextPos, moduleStart, preferredPkg, expectedKind)
		if !ok {
			return "", false
		}
		return best.TypeName, true
	}

	if typeName, ok := resolveBySymbol(trimmed, !strings.Contains(trimmed, ".")); ok {
		return typeName, true
	}
	if typeName, ok := resolveByAlias(trimmed, 0); ok {
		return typeName, true
	}
	if typeName, ok := resolveByShort(trimmed, !strings.Contains(trimmed, ".")); ok {
		return typeName, true
	}

	if strings.Contains(trimmed, ".") {
		parts := strings.Split(trimmed, ".")
		first := parts[0]
		last := parts[len(parts)-1]
		targetModuleStart := 0
		if imports := resolver.moduleImports[contextModuleStart]; imports != nil {
			targetModuleStart = imports[first]
		}
		if typeName, ok := resolveByAlias(last, targetModuleStart); ok {
			return typeName, true
		}
		if typeName, ok := resolveBySymbol(last, false); ok {
			return typeName, true
		}
		if typeName, ok := resolveByShort(last, false); ok {
			return typeName, true
		}
		if typeName, ok := resolveBySymbol(first, false); ok {
			return typeName, true
		}
	}

	return "", false
}

// fallbackTypeToken generates a valid placeholder type name from an unresolvable reference.
func fallbackTypeToken(ref string) string {
	token := strings.TrimSpace(ref)
	if token == "" {
		return token
	}
	if strings.Contains(token, ".") {
		parts := strings.Split(token, ".")
		return parts[len(parts)-1]
	}
	return token
}

// absInt returns the absolute value of an integer.
func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
