import { Text, TextProps, StyleSheet } from 'react-native'

export default function Text1(props: TextProps) {
    return (
        <Text style={styles.textStyle} {...props}>{props.children}</Text>
    )
}

const styles = StyleSheet.create({
    textStyle: {
        color: "red"
    }
})