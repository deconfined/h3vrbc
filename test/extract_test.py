"""Regression for string-array type trees used by optic controllers."""
from types import SimpleNamespace
import unittest

from tools.extract import fix_string_arrays


def node(kind, *children):
    return SimpleNamespace(m_Type=kind, m_Children=list(children))


class TypeTreeTests(unittest.TestCase):
    def test_string_arrays_are_vectors_but_regular_strings_remain_strings(self):
        string = node("string", node("Array", node("int"), node("char")))
        array = node("string", node("Array", node("int"), string))
        root = node("Controller", string, array)
        fix_string_arrays(root)
        self.assertEqual(array.m_Type, "vector")
        self.assertEqual(string.m_Type, "string")
        fix_string_arrays(root)
        self.assertEqual(array.m_Type, "vector", "Correction is idempotent")
