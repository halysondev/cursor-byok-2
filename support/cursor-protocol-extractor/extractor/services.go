// services.go parses enums, service methods, and matching braces of minified objects.
package main

import (
	"regexp"
	"strconv"
)

// extractEnums pulls enums out of legacy and factory-style declarations.
func extractEnums(text string, moduleStarts []int) []Enum {
	var enums []Enum
	enumExists := func(typeName, varName string) bool {
		for _, existing := range enums {
			if existing.TypeName == typeName && existing.VarName == varName {
				return true
			}
		}
		return false
	}

	// Match setEnumType(XXX, "xxx.v1.EnumName", [...]) enum declarations in any package.
	// JS variable names may contain $
	enumRe := regexp.MustCompile(`setEnumType\s*\(\s*([\w$]+)\s*,\s*"([\w.]+)"\s*,\s*\[`)

	matches := enumRe.FindAllStringSubmatchIndex(text, -1)
	for _, match := range matches {
		varName := text[match[2]:match[3]]
		typeName := text[match[4]:match[5]]

		// Extract the enum value array.
		bracketStart := match[1] - 1
		values := extractEnumValues(text, bracketStart)

		pkg, shortName := parseTypeName(typeName)
		enum := Enum{
			TypeName:    typeName,
			VarName:     varName,
			Values:      values,
			Package:     pkg,
			ShortName:   shortName,
			Pos:         match[0],
			ModuleStart: moduleStartForPos(moduleStarts, match[0]),
		}
		enums = append(enums, enum)
	}

	// Match the modern @bufbuild/protobuf factory form, e.g. Role=A.makeEnum("aiserver.v1.InferenceMessageRole",[{...}]).
	enumFactoryRe := regexp.MustCompile(`([\w$]+)\s*=\s*[\w$.]+\.makeEnum\s*\(\s*["']([\w.]+)["']\s*,\s*\[`)
	factoryMatches := enumFactoryRe.FindAllStringSubmatchIndex(text, -1)
	for _, match := range factoryMatches {
		varName := text[match[2]:match[3]]
		typeName := text[match[4]:match[5]]
		if enumExists(typeName, varName) {
			continue
		}

		bracketStart := match[1] - 1
		if bracketStart < 0 || bracketStart >= len(text) || text[bracketStart] != '[' {
			continue
		}

		pkg, shortName := parseTypeName(typeName)
		enums = append(enums, Enum{
			TypeName:    typeName,
			VarName:     varName,
			Values:      extractEnumValues(text, bracketStart),
			Package:     pkg,
			ShortName:   shortName,
			Pos:         match[0],
			ModuleStart: moduleStartForPos(moduleStarts, match[0]),
		})
	}

	return enums
}

// extractServices pulls services out of named or anonymous descriptors.
func extractServices(text string, moduleStarts []int) []Service {
	var services []Service
	seenTypeNames := make(map[string]bool)
	appendService := func(varName, typeName string, pos, methodsStart int) {
		if seenTypeNames[typeName] {
			return
		}
		methodsEnd := findMatchingBrace(text, methodsStart)
		if methodsEnd == -1 {
			return
		}

		pkg, shortName := parseTypeName(typeName)
		services = append(services, Service{
			TypeName:    typeName,
			VarName:     varName,
			Methods:     extractMethods(text[methodsStart:methodsEnd]),
			Package:     pkg,
			ShortName:   shortName,
			Pos:         pos,
			ModuleStart: moduleStartForPos(moduleStarts, pos),
		})
		seenTypeNames[typeName] = true
	}

	// Match VarName = { typeName: "xxx.v1.ServiceName", methods: { ... } } service objects.
	serviceRe := regexp.MustCompile(`([\w$]+)\s*=\s*\{\s*typeName:\s*"([\w.]+)"\s*,\s*methods:\s*\{`)

	matches := serviceRe.FindAllStringSubmatchIndex(text, -1)
	for _, match := range matches {
		varName := text[match[2]:match[3]]
		typeName := text[match[4]:match[5]]

		appendService(varName, typeName, match[0], match[1]-1)
	}

	// Some bundles put service descriptors directly into an array without assigning them to a variable first.
	anonymousServiceRe := regexp.MustCompile(`\{\s*typeName:\s*["']([\w.]+)["']\s*,\s*methods:\s*\{`)
	for _, match := range anonymousServiceRe.FindAllStringSubmatchIndex(text, -1) {
		typeName := text[match[2]:match[3]]
		appendService("", typeName, match[0], match[1]-1)
	}

	return services
}

// extractMethods parses the RPC method list in a service object.
func extractMethods(methodsText string) []Method {
	var methods []Method

	// Match method objects carrying name, input, output, and call kind.
	methodRe := regexp.MustCompile(`\w+:\s*\{\s*name:\s*"([^"]+)"\s*,\s*I:\s*([\w$.]+)\s*,\s*O:\s*([\w$.]+)\s*,\s*kind:\s*[\w$.]+\.(Unary|ServerStreaming|ClientStreaming|BiDiStreaming)`)

	matches := methodRe.FindAllStringSubmatch(methodsText, -1)
	for _, m := range matches {
		method := Method{
			Name:       m[1],
			InputType:  m[2],
			OutputType: m[3],
			Kind:       m[4],
		}
		methods = append(methods, method)
	}

	return methods
}

// findMatchingBrace finds the end of a brace block.
func findMatchingBrace(text string, start int) int {
	depth := 0
	for i := start; i < len(text); i++ {
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

// extractEnumValues parses enum values starting at the array.
func extractEnumValues(text string, start int) []EnumValue {
	// Find the closing bracket paired with the array.
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

	var values []EnumValue
	valueRe := regexp.MustCompile(`\{\s*no:\s*(\d+)\s*,\s*name:\s*"([^"]+)"`)

	matches := valueRe.FindAllStringSubmatch(arrayText, -1)
	for _, m := range matches {
		no, _ := strconv.Atoi(m[1])
		values = append(values, EnumValue{No: no, Name: m[2]})
	}

	return values
}
