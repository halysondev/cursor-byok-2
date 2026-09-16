// messages.go parses message declarations, field arrays, and field type information.
package main

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// extractMessages pulls message declarations out of the various bundle syntaxes.
func extractMessages(text string, moduleStarts []int) []Message {
	var messages []Message
	messageExists := func(typeName, varName string) bool {
		for _, existing := range messages {
			if existing.TypeName == typeName && existing.VarName == varName {
				return true
			}
		}
		return false
	}

	// Form one: a variable references an inheriting base class whose class body declares typeName and fields.
	// First find every "varName = class innerClassName" definition.
	// JS variable names may contain $, e.g. B$e, qg.
	// Capture both the outer variable name and the inner class name, since field references may use either.
	classDefRe := regexp.MustCompile(`([\w$]+)\s*=\s*class\s+([\w$]+)\s+extends\s+[\w$.]+\s*\{`)
	classMatches := classDefRe.FindAllStringSubmatchIndex(text, -1)

	// Read the full type name from this.typeName on any package.
	typeNameRe := regexp.MustCompile(`this\.typeName\s*=\s*"([\w.]+)"`)

	// Read the field array from the this.fields newFieldList callback.
	fieldsRe := regexp.MustCompile(`this\.fields\s*=\s*\w+(?:\.proto3)?\.util\.newFieldList\s*\(\s*\(\s*\)\s*=>\s*\[`)

	for _, classMatch := range classMatches {
		varName := text[classMatch[2]:classMatch[3]]
		internalName := text[classMatch[4]:classMatch[5]]
		classStart := classMatch[0]

		// Find the end of the class (matching braces)
		classEnd := findClassEnd(text, classMatch[1]-1)
		if classEnd == -1 {
			continue
		}

		classBody := text[classStart:classEnd]

		// Look for typeName inside the class body
		typeMatch := typeNameRe.FindStringSubmatch(classBody)
		if typeMatch == nil {
			continue
		}
		typeName := typeMatch[1]

		// Look for fields inside the class body
		fieldsMatch := fieldsRe.FindStringIndex(classBody)
		if fieldsMatch == nil {
			continue
		}

		// Find the start of the fields array
		bracketPos := classStart + fieldsMatch[1] - 1
		fields := extractFieldArray(text, bracketPos)

		pkg, shortName := parseTypeName(typeName)
		msg := Message{
			TypeName:     typeName,
			VarName:      varName,
			InternalName: internalName,
			Fields:       fields,
			Package:      pkg,
			ShortName:    shortName,
			Pos:          classStart,
			ModuleStart:  moduleStartForPos(moduleStarts, classStart),
		}
		messages = append(messages, msg)
	}

	// Form two: message declarations as consecutive assignments in transpiled or minified bundles.
	// e.g. i.runtime=n.proto3,i.typeName="agent.v1.McpArgs",i.fields=n.proto3.util.newFieldList(()=>[{...}]).
	assignmentRe := regexp.MustCompile(`([\w$]+)\.typeName\s*=\s*"([\w.]+)"\s*,\s*[\w$]+\.fields\s*=\s*\w+(?:\.\w+)*\.util\.newFieldList\s*\(\s*\(\s*\)\s*=>\s*\[`)
	assignmentMatches := assignmentRe.FindAllStringSubmatchIndex(text, -1)
	for _, m := range assignmentMatches {
		varName := text[m[2]:m[3]]
		typeName := text[m[4]:m[5]]

		// Skip duplicates already extracted by the class-body form.
		if messageExists(typeName, varName) {
			continue
		}

		// The regex stops before the opening bracket; the array start is located from the match tail.
		start := m[1] - 1
		if start < 0 || start >= len(text) || text[start] != '[' {
			continue
		}
		fields := extractFieldArray(text, start)

		pkg, shortName := parseTypeName(typeName)
		messages = append(messages, Message{
			TypeName:     typeName,
			VarName:      varName,
			InternalName: "",
			Fields:       fields,
			Package:      pkg,
			ShortName:    shortName,
			Pos:          m[0],
			ModuleStart:  moduleStartForPos(moduleStarts, m[0]),
		})
	}

	// Form three: modern @bufbuild/protobuf factory calls.
	// e.g. Req=A.makeMessageType("aiserver.v1.HasSeenAdRequest",()=>[{...}]).
	messageFactoryRe := regexp.MustCompile(`([\w$]+)\s*=\s*[\w$.]+\.makeMessageType\s*\(\s*["']([\w.]+)["']\s*,\s*\(\s*\)\s*=>\s*\[`)
	factoryMatches := messageFactoryRe.FindAllStringSubmatchIndex(text, -1)
	for _, m := range factoryMatches {
		varName := text[m[2]:m[3]]
		typeName := text[m[4]:m[5]]
		if messageExists(typeName, varName) {
			continue
		}

		bracketStart := m[1] - 1
		if bracketStart < 0 || bracketStart >= len(text) || text[bracketStart] != '[' {
			continue
		}

		pkg, shortName := parseTypeName(typeName)
		messages = append(messages, Message{
			TypeName:    typeName,
			VarName:     varName,
			Fields:      extractFieldArray(text, bracketStart),
			Package:     pkg,
			ShortName:   shortName,
			Pos:         m[0],
			ModuleStart: moduleStartForPos(moduleStarts, m[0]),
		})
	}

	// Empty messages pass the field array directly instead of a lazy callback.
	// e.g. Res=A.makeMessageType("aiserver.v1.MarkAdAsSeenResponse",[]).
	emptyMessageFactoryRe := regexp.MustCompile(`([\w$]+)\s*=\s*[\w$.]+\.makeMessageType\s*\(\s*["']([\w.]+)["']\s*,\s*\[`)
	emptyFactoryMatches := emptyMessageFactoryRe.FindAllStringSubmatchIndex(text, -1)
	for _, m := range emptyFactoryMatches {
		varName := text[m[2]:m[3]]
		typeName := text[m[4]:m[5]]
		if messageExists(typeName, varName) {
			continue
		}

		bracketStart := m[1] - 1
		if bracketStart < 0 || bracketStart >= len(text) || text[bracketStart] != '[' {
			continue
		}

		pkg, shortName := parseTypeName(typeName)
		messages = append(messages, Message{
			TypeName:    typeName,
			VarName:     varName,
			Fields:      extractFieldArray(text, bracketStart),
			Package:     pkg,
			ShortName:   shortName,
			Pos:         m[0],
			ModuleStart: moduleStartForPos(moduleStarts, m[0]),
		})
	}

	return messages
}

// findClassEnd finds the closing brace paired with a class definition.
func findClassEnd(text string, openBrace int) int {
	depth := 0
	for i := openBrace; i < len(text); i++ {
		if text[i] == '{' {
			depth++
		} else if text[i] == '}' {
			depth--
			if depth == 0 {
				return i + 1
			}
		}
	}
	return -1
}

// extractFieldArray parses a complete field array starting at its opening bracket.
func extractFieldArray(text string, start int) []Field {
	// Find the closing bracket paired with the field array.
	depth := 0
	end := start
	for i := start; i < len(text); i++ {
		if text[i] == '[' {
			depth++
		} else if text[i] == ']' {
			depth--
			if depth == 0 {
				end = i + 1
				break
			}
		}
	}

	arrayText := text[start:end]

	// Parse an independent field object per brace block.
	var fields []Field

	// Find field objects in order.
	fieldObjects := extractFieldObjects(arrayText)

	for _, fieldObj := range fieldObjects {
		field, parseErr := parseFieldObject(fieldObj)
		if parseErr != nil {
			activeDiagnostics.addSkippedField(fieldObj, parseErr)
			continue
		}
		activeDiagnostics.addParsedField()
		fields = append(fields, *field)
	}

	return fields
}

// extractFieldObjects extracts independent field objects from array text.
func extractFieldObjects(arrayText string) []string {
	var objects []string
	depth := 0
	start := -1

	for i := 0; i < len(arrayText); i++ {
		if arrayText[i] == '{' {
			if depth == 0 {
				start = i
			}
			depth++
		} else if arrayText[i] == '}' {
			depth--
			if depth == 0 && start >= 0 {
				objects = append(objects, arrayText[start:i+1])
				start = -1
			}
		}
	}

	return objects
}

// parseFieldObject parses a single field object with number, name, type, and modifiers.
func parseFieldObject(obj string) (*Field, error) {
	// Extract the field number.
	noMatch := noRe.FindStringSubmatch(obj)
	if noMatch == nil {
		return nil, errors.New("missing field no")
	}
	no, _ := strconv.Atoi(noMatch[1])

	// Extract the field name.
	nameMatch := nameRe.FindStringSubmatch(obj)
	if nameMatch == nil {
		return nil, errors.New("missing field name")
	}
	name := strings.TrimSpace(nameMatch[1])
	if !fieldNameRe.MatchString(name) {
		return nil, fmt.Errorf("invalid field name: %s", name)
	}

	// Extract the field kind.
	kindMatch := kindRe.FindStringSubmatch(obj)
	if kindMatch == nil {
		return nil, errors.New("missing field kind")
	}
	kind := strings.TrimSpace(kindMatch[1])

	field := &Field{
		No:   no,
		Name: name,
		Kind: kind,
	}

	// Type T may be a scalar number, a variable name, or a getEnumType enum call.

	// Enums match getEnumType calls first.
	if enumMatch := enumTypeRe.FindStringSubmatch(obj); enumMatch != nil {
		field.T = enumMatch[1]
	} else {
		// Other types match a plain T property value.
		if tMatch := tRe.FindStringSubmatch(obj); tMatch != nil {
			if t, err := strconv.Atoi(tMatch[1]); err == nil {
				field.T = t
			} else {
				field.T = tMatch[1]
			}
		} else if shorthandTRe.MatchString(obj) {
			field.T = "T"
		}
	}

	// Check oneof grouping only within the current field object.
	if oneofMatch := oneofRe.FindStringSubmatch(obj); oneofMatch != nil {
		candidate := strings.TrimSpace(oneofMatch[1])
		if oneofNameRe.MatchString(candidate) {
			field.Oneof = candidate
		}
	}

	// Check repeated only within the current field object; !0 means true in minified JS.
	if repeatedRe.MatchString(obj) {
		field.Repeated = true
	}

	// Check optional only within the current field object.
	if optRe.MatchString(obj) {
		field.Opt = true
	}

	// map fields are represented by a K key type and a V value descriptor together.
	if field.Kind == "map" {
		// Extract the map key type.
		if keyMatch := keyRe.FindStringSubmatch(obj); keyMatch != nil {
			field.MapKey, _ = strconv.Atoi(keyMatch[1])
		}

		// Extract the map value type, tolerating property order changes.
		if valueMatch := mapValueRe.FindStringSubmatch(obj); valueMatch != nil {
			valueObj := valueMatch[1]
			if kindMatch := mapValueKRe.FindStringSubmatch(valueObj); kindMatch != nil {
				field.MapValueKind = kindMatch[1]
			}
			if tMatch := mapValueTRe.FindStringSubmatch(valueObj); tMatch != nil {
				if t, err := strconv.Atoi(tMatch[1]); err == nil {
					field.MapValueT = t
				} else {
					field.MapValueT = tMatch[1]
				}
			}
		}
	}

	return field, nil
}
